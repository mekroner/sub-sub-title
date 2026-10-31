//! Local text to speech for the Voiceover tab: Resemble AI's Chatterbox, run
//! by a Python sidecar on the user's GPU.
//!
//! Installing it is a chain of `uv` invocations rather than a single archive:
//! a private uv, a private CPython, a venv, PyTorch's CUDA build from
//! PyTorch's own index (PyPI's Windows torch is CPU-only), then Chatterbox.
//! Everything lives under the app's local data directory, so nothing touches a
//! Python the user may already have.
//!
//! The sidecar stays running once started, so the model is loaded onto the GPU
//! once rather than per line. It speaks one JSON object per line over
//! stdin/stdout and exits when its stdin closes — which is what happens when
//! the app exits, however it exits.

use crate::engine::{free_space, human_bytes, local_dir, tar_bin};
use crate::error::{AppError, AppResult};
use crate::media::{ffmpeg_bin, quiet_command};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const UV_VERSION: &str = "0.13.6";
const UV_URL: &str =
    "https://github.com/astral-sh/uv/releases/download/0.13.6/uv-x86_64-pc-windows-msvc.zip";
const UV_SHA256: &str = "a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f";
const PYTHON_VERSION: &str = "3.11";
/// Chatterbox pins torch 2.6; this is the CUDA 12.4 build of exactly that.
const TORCH_INDEX: &str = "https://download.pytorch.org/whl/cu124";
const TORCH_PACKAGES: [&str; 2] = ["torch==2.6.0", "torchaudio==2.6.0"];
/// `setuptools` because Resemble's watermarker imports `pkg_resources`, which
/// uv's venvs do not include and setuptools 81 drops. Without it the import
/// fails silently and the model fails to load with "NoneType is not callable".
const CHATTERBOX_PACKAGES: [&str; 2] = ["chatterbox-tts==0.1.7", "setuptools<81"];
/// Bumped whenever any pin above changes, so an older install is redone.
const INSTALL_VERSION: &str = "chatterbox-0.1.7+torch-2.6.0-cu124+1";
/// PyTorch with CUDA (2.5 GB), Chatterbox's dependencies and the Turbo
/// weights (3.8 GB), measured.
const DOWNLOAD_BYTES: u64 = 7_000_000_000;
const REQUIRED_FREE_BYTES: u64 = 16 * 1024 * 1024 * 1024;
/// transformers nests files about 150 characters deep inside the venv, and
/// Python on Windows fails to open anything past 260 characters unless long
/// paths are enabled machine-wide. A root longer than this would break the
/// install in a way that looks like a missing file.
const MAX_ROOT_CHARS: usize = 100;
const SERVER_SOURCE: &str = include_str!("../tts/server.py");

#[derive(Default)]
pub struct TtsState {
    install_child: Arc<Mutex<Option<Child>>>,
    install_cancelled: Arc<AtomicBool>,
    sidecar: Arc<Mutex<Option<Sidecar>>>,
}

struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    /// The last lines it wrote to stderr, for when it dies.
    stderr_tail: Arc<Mutex<Vec<String>>>,
    next_id: u64,
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: String,
    python: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsStatus {
    pub installed: bool,
    pub version: String,
    pub download_bytes: u64,
    pub required_free_bytes: u64,
    /// 0 when it could not be determined.
    pub disk_free_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsInstallProgress {
    /// 1-based step of `steps`.
    pub step: u32,
    pub steps: u32,
    pub label: String,
    /// The installer's latest line of output, for a sense of motion.
    pub detail: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsRequest {
    /// "turbo" or "standard".
    pub engine: String,
    pub text: String,
    /// A clip of the voice to clone; none means the model's own default voice.
    pub reference: Option<String>,
    pub seed: u64,
    pub exaggeration: f64,
    pub cfg_weight: f64,
    pub temperature: f64,
    pub output_path: String,
    /// For a line spoken across several cues: each cue's words, to be found
    /// in the generated audio.
    #[serde(default)]
    pub align_segments: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsResult {
    pub path: String,
    pub duration: f64,
    /// Where each aligned segment starts and ends, in seconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marks: Option<Vec<[f64; 2]>>,
}

// --- Paths ------------------------------------------------------------------

fn root(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = local_dir(app)?.join("tts");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn manifest_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(root(app)?.join("tts.json"))
}

/// The installed interpreter, if the install is complete and current.
fn installed_python(app: &AppHandle) -> Option<PathBuf> {
    let bytes = std::fs::read(manifest_path(app).ok()?).ok()?;
    let manifest: Manifest = serde_json::from_slice(&bytes).ok()?;
    (manifest.version == INSTALL_VERSION && manifest.python.is_file()).then_some(manifest.python)
}

/// Environment shared by the installer and the sidecar: every cache and
/// download goes under our own directory.
fn apply_env(cmd: &mut Command, root: &Path) {
    cmd.env("UV_CACHE_DIR", root.join("uv-cache"))
        .env("UV_PYTHON_INSTALL_DIR", root.join("python"))
        .env("UV_PYTHON_PREFERENCE", "only-managed")
        .env("UV_NO_CONFIG", "1")
        .env("HF_HOME", root.join("hf"))
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        // Windows without Developer Mode cannot symlink; the cache copes.
        .env("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
        // The aligner's weights, fetched through torch.hub on first use.
        .env("TORCH_HOME", root.join("torch"))
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        // Stray `pip` config or an activated venv in the user's shell must not
        // leak into ours.
        .env_remove("VIRTUAL_ENV")
        .env_remove("PYTHONHOME")
        .env_remove("PYTHONPATH");
}

// --- Status -----------------------------------------------------------------

#[tauri::command]
pub fn tts_status(app: AppHandle) -> AppResult<TtsStatus> {
    Ok(TtsStatus {
        installed: installed_python(&app).is_some(),
        version: INSTALL_VERSION.to_string(),
        download_bytes: DOWNLOAD_BYTES,
        required_free_bytes: REQUIRED_FREE_BYTES,
        disk_free_bytes: free_space(&root(&app)?),
    })
}

// --- Install ----------------------------------------------------------------

#[tauri::command]
pub fn cancel_tts_install(state: tauri::State<'_, TtsState>) {
    state.install_cancelled.store(true, Ordering::SeqCst);
    if let Ok(mut guard) = state.install_child.lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
        }
    }
}

#[tauri::command]
pub async fn install_tts(app: AppHandle, state: tauri::State<'_, TtsState>) -> AppResult<()> {
    if installed_python(&app).is_some() {
        return Ok(());
    }
    let root = root(&app)?;
    if root.as_os_str().len() > MAX_ROOT_CHARS {
        return Err(AppError::msg(format!(
            "The voice engine cannot be installed under {}: the path is too long for \
             Python's files on Windows. Enabling long paths in Windows fixes this.",
            root.display()
        )));
    }
    let free = free_space(&root);
    if free > 0 && free < REQUIRED_FREE_BYTES {
        return Err(AppError::msg(format!(
            "There is not enough disk space for the voice engine. It needs about {} free \
             while installing, but only {} is.",
            human_bytes(REQUIRED_FREE_BYTES),
            human_bytes(free)
        )));
    }

    state.install_cancelled.store(false, Ordering::SeqCst);
    let cancelled = state.install_cancelled.clone();
    let child_slot = state.install_child.clone();

    // A previous install of other pins is replaced, not patched.
    if let Ok(mut guard) = state.sidecar.lock() {
        *guard = None;
    }

    let uv = fetch_uv(&app, &root, &cancelled).await?;
    tauri::async_runtime::spawn_blocking(move || {
        install_steps(&app, &root, &uv, &cancelled, &child_slot)
    })
    .await
    .map_err(|e| AppError::msg(format!("The voice engine install failed: {e}")))?
}

const STEPS: u32 = 6;

fn progress(app: &AppHandle, step: u32, label: &str, detail: &str) {
    let _ = app.emit(
        "tts-install-progress",
        TtsInstallProgress {
            step,
            steps: STEPS,
            label: label.to_string(),
            detail: detail.to_string(),
        },
    );
}

/// Downloads and verifies a private uv. Small (15 MB), so no resume.
async fn fetch_uv(app: &AppHandle, root: &Path, cancelled: &AtomicBool) -> AppResult<PathBuf> {
    let dir = root.join("uv").join(UV_VERSION);
    let exe = dir.join("uv.exe");
    if exe.is_file() {
        return Ok(exe);
    }
    progress(app, 1, "Downloading the Python installer (uv)", UV_URL);
    std::fs::create_dir_all(&dir)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
        .build()?;
    let bytes = client
        .get(UV_URL)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| AppError::msg(format!("Could not download uv: {e}")))?
        .bytes()
        .await?;
    if cancelled.load(Ordering::SeqCst) {
        return Err(AppError::msg("The install was cancelled."));
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if digest != UV_SHA256 {
        return Err(AppError::msg(
            "The downloaded uv did not match its published checksum, so it was not used.",
        ));
    }
    let zip = dir.join("uv.zip");
    std::fs::write(&zip, &bytes)?;
    let status = quiet_command(&tar_bin())
        .arg("-xf")
        .arg(&zip)
        .arg("-C")
        .arg(&dir)
        .status()?;
    let _ = std::fs::remove_file(&zip);
    if !status.success() || !exe.is_file() {
        return Err(AppError::msg("Could not unpack uv."));
    }
    Ok(exe)
}

fn install_steps(
    app: &AppHandle,
    root: &Path,
    uv: &Path,
    cancelled: &AtomicBool,
    child_slot: &Mutex<Option<Child>>,
) -> AppResult<()> {
    let venv = root.join("venv");
    let python = venv.join("Scripts").join("python.exe");
    let uv_cmd = |args: &[&str]| {
        let mut cmd = quiet_command(&uv.to_string_lossy());
        apply_env(&mut cmd, root);
        cmd.args(args);
        cmd
    };

    let label = "Installing Python";
    progress(app, 2, label, "");
    // Starting clean: a venv left by a failed or older install is not trusted.
    if venv.exists() {
        std::fs::remove_dir_all(&venv)?;
    }
    let mut cmd = uv_cmd(&["venv", "--python", PYTHON_VERSION]);
    cmd.arg(&venv);
    run_step(app, cmd, 2, label, cancelled, child_slot)?;

    let label = "Downloading PyTorch with CUDA (about 2.5 GB)";
    progress(app, 3, label, "");
    let mut cmd = uv_cmd(&["pip", "install", "--python"]);
    cmd.arg(&python)
        .args(TORCH_PACKAGES)
        .args(["--index-url", TORCH_INDEX]);
    run_step(app, cmd, 3, label, cancelled, child_slot)?;

    let label = "Installing Chatterbox";
    progress(app, 4, label, "");
    let mut cmd = uv_cmd(&["pip", "install", "--python"]);
    cmd.arg(&python).args(CHATTERBOX_PACKAGES);
    run_step(app, cmd, 4, label, cancelled, child_slot)?;

    // Loading the model once downloads its weights now, while the user is
    // watching a progress bar, rather than on the first line they generate.
    let label = "Downloading the voice model";
    progress(app, 5, label, "");
    let server = write_server(root)?;
    let mut cmd = quiet_command(&python.to_string_lossy());
    apply_env(&mut cmd, root);
    cmd.arg(&server).args(["--warmup", "turbo"]);
    run_step(app, cmd, 5, label, cancelled, child_slot)?;

    let label = "Tidying up";
    progress(app, 6, label, "");
    // The cache holds a second copy of every wheel, PyTorch included.
    let _ = run_step(app, uv_cmd(&["cache", "clean"]), 6, label, cancelled, child_slot);

    std::fs::write(
        root.join("tts.json"),
        serde_json::to_vec_pretty(&Manifest {
            version: INSTALL_VERSION.to_string(),
            python,
        })?,
    )?;
    progress(app, STEPS, "Done", "");
    Ok(())
}

/// Runs one install step to completion, streaming its output as progress
/// detail and keeping the tail for the error message.
fn run_step(
    app: &AppHandle,
    mut cmd: Command,
    step: u32,
    label: &str,
    cancelled: &AtomicBool,
    child_slot: &Mutex<Option<Child>>,
) -> AppResult<()> {
    if cancelled.load(Ordering::SeqCst) {
        return Err(AppError::msg("The install was cancelled."));
    }
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::msg(format!("Could not start the installer: {e}")))?;
    let tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let readers: Vec<_> = [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    .map(|stream| {
        let tail = tail.clone();
        let app = app.clone();
        let label = label.to_string();
        std::thread::spawn(move || {
            // uv redraws progress with carriage returns; split on those too.
            let mut reader = BufReader::new(stream);
            let mut buf = Vec::new();
            while reader.read_until(b'\n', &mut buf).map(|n| n > 0).unwrap_or(false) {
                for piece in String::from_utf8_lossy(&buf).split('\r') {
                    let line = piece.trim();
                    if line.is_empty() {
                        continue;
                    }
                    progress(&app, step, &label, line);
                    if let Ok(mut t) = tail.lock() {
                        t.push(line.to_string());
                        if t.len() > 15 {
                            t.remove(0);
                        }
                    }
                }
                buf.clear();
            }
        })
    })
    .collect();

    *child_slot.lock().map_err(|_| AppError::msg("Install lock poisoned."))? = Some(child);
    let status = loop {
        {
            let mut guard = child_slot.lock().map_err(|_| AppError::msg("Install lock poisoned."))?;
            let Some(child) = guard.as_mut() else {
                break None;
            };
            if let Some(status) = child.try_wait()? {
                *guard = None;
                break Some(status);
            }
        }
        std::thread::sleep(Duration::from_millis(150));
    };
    for reader in readers {
        let _ = reader.join();
    }
    if cancelled.load(Ordering::SeqCst) {
        return Err(AppError::msg("The install was cancelled."));
    }
    match status {
        Some(s) if s.success() => Ok(()),
        _ => Err(AppError::msg(format!(
            "{label} failed.\n{}",
            tail.lock().map(|t| t.join("\n")).unwrap_or_default()
        ))),
    }
}

/// The sidecar script ships inside the app and is written out next to the
/// venv, so an app update updates the script without a reinstall.
fn write_server(root: &Path) -> AppResult<PathBuf> {
    let path = root.join("server.py");
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current != SERVER_SOURCE {
        std::fs::write(&path, SERVER_SOURCE)?;
    }
    Ok(path)
}

// --- Generating ---------------------------------------------------------------

#[tauri::command]
pub async fn tts_generate(
    app: AppHandle,
    state: tauri::State<'_, TtsState>,
    request: TtsRequest,
) -> AppResult<TtsResult> {
    let python = installed_python(&app)
        .ok_or_else(|| AppError::msg("The voice engine is not installed yet."))?;
    let root = root(&app)?;
    if let Some(dir) = Path::new(&request.output_path).parent() {
        std::fs::create_dir_all(dir)?;
    }
    let slot = state.sidecar.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let on_event = |event: TtsEvent| {
            let _ = app.emit("tts-event", event);
        };
        generate(&root, &python, &slot, &request, &on_event)
    })
    .await
        .map_err(|e| AppError::msg(format!("Generating speech failed: {e}")))?
}

/// Stops the sidecar, freeing the GPU memory the model holds.
#[tauri::command]
pub fn tts_unload(state: tauri::State<'_, TtsState>) {
    if let Ok(mut guard) = state.sidecar.lock() {
        *guard = None;
    }
}

#[derive(Deserialize)]
struct Reply {
    id: Option<u64>,
    event: Option<String>,
    ok: Option<bool>,
    error: Option<String>,
    path: Option<String>,
    duration: Option<f64>,
    detail: Option<String>,
    marks: Option<Vec<[f64; 2]>>,
}

#[derive(Clone, Serialize)]
pub struct TtsEvent {
    pub event: String,
    pub detail: String,
}

fn generate(
    root: &Path,
    python: &Path,
    slot: &Mutex<Option<Sidecar>>,
    request: &TtsRequest,
    on_event: &dyn Fn(TtsEvent),
) -> AppResult<TtsResult> {
    let mut guard = slot
        .lock()
        .map_err(|_| AppError::msg("The voice engine lock was poisoned."))?;
    let alive = guard
        .as_mut()
        .is_some_and(|s| matches!(s.child.try_wait(), Ok(None)));
    if !alive {
        *guard = Some(spawn_sidecar(root, python)?);
    }
    let sidecar = guard.as_mut().expect("just ensured");

    let outcome = exchange(
        sidecar,
        serde_json::json!({
            "op": "generate",
            "engine": request.engine,
            "text": request.text,
            "reference": request.reference,
            "seed": request.seed,
            "exaggeration": request.exaggeration,
            "cfgWeight": request.cfg_weight,
            "temperature": request.temperature,
            "out": request.output_path,
        }),
        on_event,
    )
    .map(|reply| {
        let path = reply.path.unwrap_or_else(|| request.output_path.clone());
        // A line spoken across cues also needs to know where each cue's
        // words fell. A failed alignment costs only that: the caller falls
        // back to an estimate, and the line itself stands.
        let marks = match &request.align_segments {
            Some(segments) if segments.len() > 1 => exchange(
                sidecar,
                serde_json::json!({ "op": "align", "audio": path, "segments": segments }),
                on_event,
            )
            .ok()
            .and_then(|r| r.marks)
            .filter(|m| m.len() == segments.len()),
            _ => None,
        };
        TtsResult {
            path,
            duration: reply.duration.unwrap_or(0.0),
            marks,
        }
    });

    if outcome.is_err() && !matches!(sidecar.child.try_wait(), Ok(None)) {
        // It died: report why, and start a fresh one next time.
        let tail = sidecar
            .stderr_tail
            .lock()
            .map(|t| t.join("\n"))
            .unwrap_or_default();
        *guard = None;
        return Err(AppError::msg(format!(
            "The voice engine stopped unexpectedly.\n{tail}"
        )));
    }
    outcome
}

/// Sends one request and waits for its reply, passing events on as they come.
/// An error reply is an `Err` carrying the sidecar's own message.
fn exchange(
    sidecar: &mut Sidecar,
    mut request: serde_json::Value,
    on_event: &dyn Fn(TtsEvent),
) -> AppResult<Reply> {
    sidecar.next_id += 1;
    let id = sidecar.next_id;
    request["id"] = id.into();
    writeln!(sidecar.stdin, "{request}")
        .and_then(|_| sidecar.stdin.flush())
        .map_err(|e| AppError::msg(format!("The voice engine stopped listening ({e}).")))?;
    loop {
        let mut text = String::new();
        if sidecar.stdout.read_line(&mut text)? == 0 {
            return Err(AppError::msg("The voice engine stopped unexpectedly."));
        }
        let Ok(reply) = serde_json::from_str::<Reply>(text.trim()) else {
            continue;
        };
        if let Some(event) = reply.event {
            // "loading" while a model is read into the GPU; the first time,
            // that includes downloading its weights.
            on_event(TtsEvent {
                event,
                detail: reply.detail.unwrap_or_default(),
            });
            continue;
        }
        if reply.id != Some(id) {
            continue;
        }
        return if reply.ok == Some(true) {
            Ok(reply)
        } else {
            Err(AppError::msg(
                reply.error.unwrap_or_else(|| "The voice engine failed.".to_string()),
            ))
        };
    }
}

fn spawn_sidecar(root: &Path, python: &Path) -> AppResult<Sidecar> {
    let server = write_server(root)?;
    let mut cmd = quiet_command(&python.to_string_lossy());
    apply_env(&mut cmd, root);
    let mut child = cmd
        .arg(&server)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::msg(format!("Could not start the voice engine: {e}")))?;
    let stdin = child.stdin.take().ok_or_else(|| AppError::msg("No stdin."))?;
    let stdout = BufReader::new(child.stdout.take().ok_or_else(|| AppError::msg("No stdout."))?);
    let stderr_tail = Arc::new(Mutex::new(Vec::new()));
    if let Some(stderr) = child.stderr.take() {
        let tail = stderr_tail.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Ok(mut t) = tail.lock() {
                    t.push(line);
                    if t.len() > 25 {
                        t.remove(0);
                    }
                }
            }
        });
    }
    Ok(Sidecar {
        child,
        stdin,
        stdout,
        stderr_tail,
        next_id: 0,
    })
}

// --- Reference clips ------------------------------------------------------------

/// Cuts the given stretches out of the video's audio and joins them into one
/// mono WAV: a speaker's own lines, as a reference for cloning their voice.
/// Returns the clip's length in seconds.
#[tauri::command]
pub async fn tts_extract_reference(
    video_path: String,
    segments: Vec<[f64; 2]>,
    output_path: String,
) -> AppResult<f64> {
    tauri::async_runtime::spawn_blocking(move || {
        extract_reference(&video_path, segments, &output_path)
    })
    .await
    .map_err(|e| AppError::msg(format!("Cutting the reference failed: {e}")))?
}

fn extract_reference(
    video_path: &str,
    segments: Vec<[f64; 2]>,
    output_path: &str,
) -> AppResult<f64> {
    let segments: Vec<[f64; 2]> = segments
        .into_iter()
        .filter(|[a, b]| a.is_finite() && b.is_finite() && b > a)
        .collect();
    if segments.is_empty() {
        return Err(AppError::msg("There are no lines to take a reference from."));
    }
    if let Some(dir) = Path::new(&output_path).parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Each line is brought to the same loudness before they are joined: lines
    // cut from a film sit at whatever level the scene had, and a model cloning
    // a shout next to a mumble learns neither.
    let mut graph = String::new();
    for (i, [start, end]) in segments.iter().enumerate() {
        let gain = measure_loudness(video_path, *start, *end)
            .map(|m| m.gain_to(REFERENCE_LUFS, REFERENCE_PEAK_DBTP))
            .unwrap_or(0.0);
        graph.push_str(&format!(
            "[0:a]atrim=start={start:.3}:end={end:.3},asetpts=PTS-STARTPTS,\
             volume={gain:.2}dB[s{i}];"
        ));
    }
    for i in 0..segments.len() {
        graph.push_str(&format!("[s{i}]"));
    }
    graph.push_str(&format!("concat=n={}:v=0:a=1[out]", segments.len()));

    let out = quiet_command(&ffmpeg_bin())
        .args(["-hide_banner", "-nostdin", "-v", "error", "-y", "-i"])
        .arg(video_path)
        .args(["-filter_complex", &graph, "-map", "[out]", "-ac", "1", "-c:a", "pcm_s16le"])
        .arg(output_path)
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| AppError::msg(format!("Could not run ffmpeg: {e}")))?;
    if !out.status.success() {
        return Err(AppError::msg(format!(
            "Could not cut the reference from the video: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(segments.iter().map(|[a, b]| b - a).sum())
}

/// Every reference is brought to this integrated loudness — the level
/// Chatterbox Turbo itself normalises a reference to, so the two agree and
/// every voice in a project is cloned from equally loud speech.
const REFERENCE_LUFS: f64 = -27.0;
/// Gain never pushes a line's true peak above this.
const REFERENCE_PEAK_DBTP: f64 = -1.0;

/// A stretch of audio's loudness, as ffmpeg's EBU R128 meter reports it.
#[derive(Debug, Clone, Copy)]
struct Loudness {
    /// Integrated loudness, LUFS.
    integrated: f64,
    /// True peak, dBTP.
    true_peak: f64,
}

impl Loudness {
    /// The gain, in dB, that brings this to `target` LUFS without the true
    /// peak passing `ceiling`. Silence, or a stretch too short to measure, is
    /// left as it is.
    fn gain_to(self, target: f64, ceiling: f64) -> f64 {
        if !self.integrated.is_finite() || self.integrated < -70.0 {
            return 0.0;
        }
        let wanted = target - self.integrated;
        if self.true_peak.is_finite() {
            wanted.min(ceiling - self.true_peak)
        } else {
            wanted
        }
    }
}

/// Measures one stretch of a file with ffmpeg's `loudnorm` in analysis mode.
fn measure_loudness(path: &str, start: f64, end: f64) -> Option<Loudness> {
    let out = quiet_command(&ffmpeg_bin())
        .args(["-hide_banner", "-nostdin", "-ss", &format!("{start:.3}"), "-to", &format!("{end:.3}"), "-i"])
        .arg(path)
        .args(["-vn", "-af", "loudnorm=print_format=json", "-f", "null", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .ok()?;
    parse_loudnorm(&String::from_utf8_lossy(&out.stderr))
}

/// The JSON block `loudnorm` prints last on stderr. Its numbers are strings,
/// and "-inf" for silence.
fn parse_loudnorm(stderr: &str) -> Option<Loudness> {
    let json = &stderr[stderr.rfind('{')?..=stderr.rfind('}')?];
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let number = |key: &str| value.get(key)?.as_str()?.trim().parse::<f64>().ok();
    Some(Loudness {
        integrated: number("input_i")?,
        true_peak: number("input_tp").unwrap_or(f64::NAN),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_a_line_without_letting_it_clip() {
        // 13 dB too quiet, with room to spare: the full lift.
        let quiet = Loudness { integrated: -40.0, true_peak: -20.0 };
        assert!((quiet.gain_to(-27.0, -1.0) - 13.0).abs() < 1e-9);
        // Loud enough already: turned down.
        let loud = Loudness { integrated: -14.0, true_peak: -2.0 };
        assert!((loud.gain_to(-27.0, -1.0) + 13.0).abs() < 1e-9);
        // Peaky: lifted only as far as the peak allows.
        let peaky = Loudness { integrated: -40.0, true_peak: -5.0 };
        assert!((peaky.gain_to(-27.0, -1.0) - 4.0).abs() < 1e-9);
        // Silence is left alone rather than amplified into noise.
        let silent = Loudness { integrated: f64::NEG_INFINITY, true_peak: f64::NEG_INFINITY };
        assert_eq!(silent.gain_to(-27.0, -1.0), 0.0);
    }

    /// End to end through real ffmpeg: a quiet line and a loud one come out
    /// of the reference equally loud, at the target. Skipped without ffmpeg.
    #[test]
    fn evens_out_the_lines_of_a_reference() {
        let ok = quiet_command(&ffmpeg_bin()).arg("-version").stdout(Stdio::null()).status();
        if !ok.is_ok_and(|s| s.success()) {
            eprintln!("ffmpeg not found; skipping");
            return;
        }
        let dir = std::env::temp_dir().join(format!("sst-level-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let video = dir.join("video.wav");
        let out = dir.join("ref.wav");
        // 20 dB apart: a mumble for three seconds, then a shout.
        let made = quiet_command(&ffmpeg_bin())
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=if(lt(t\\,3)\\,0.03\\,0.3)*sin(2*PI*300*t):d=6:s=48000",
            ])
            .arg(&video)
            .status()
            .unwrap();
        assert!(made.success());

        extract_reference(
            &video.to_string_lossy(),
            vec![[0.5, 2.5], [3.5, 5.5]],
            &out.to_string_lossy(),
        )
        .expect("extracts");

        let path = out.to_string_lossy();
        let first = measure_loudness(&path, 0.0, 2.0).expect("first measured");
        let second = measure_loudness(&path, 2.0, 4.0).expect("second measured");
        assert!(
            (first.integrated - second.integrated).abs() < 1.0,
            "{first:?} vs {second:?}"
        );
        assert!((first.integrated - REFERENCE_LUFS).abs() < 1.0, "{first:?}");
        assert!(second.true_peak <= REFERENCE_PEAK_DBTP + 0.5, "{second:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_loudnorm_output() {
        let stderr = "[Parsed_loudnorm_0 @ 0x1] \n{\n\t\"input_i\" : \"-31.52\",\n\t\"input_tp\" : \"-12.03\",\n\t\"input_lra\" : \"1.20\"\n}\n";
        let m = parse_loudnorm(stderr).expect("parses");
        assert_eq!(m.integrated, -31.52);
        assert_eq!(m.true_peak, -12.03);
        assert!(parse_loudnorm("no json here").is_none());
    }

    #[test]
    fn cuts_and_joins_a_reference_from_the_video() {
        let ok = quiet_command(&ffmpeg_bin()).arg("-version").stdout(Stdio::null()).status();
        if !ok.is_ok_and(|s| s.success()) {
            eprintln!("ffmpeg not found; skipping");
            return;
        }
        let dir = std::env::temp_dir().join(format!("sst-ref-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let video = dir.join("video.wav");
        let out = dir.join("nested").join("ref.wav");
        let made = quiet_command(&ffmpeg_bin())
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=300:duration=10"])
            .arg(&video)
            .status()
            .unwrap();
        assert!(made.success());

        let seconds = extract_reference(
            &video.to_string_lossy(),
            vec![[1.0, 3.5], [6.0, 7.0], [9.0, 8.0]],
            &out.to_string_lossy(),
        )
        .expect("extracts");
        assert!((seconds - 3.5).abs() < 1e-9);

        let probe = quiet_command(&crate::media::ffprobe_bin())
            .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
            .arg(&out)
            .output()
            .unwrap();
        let measured: f64 = String::from_utf8_lossy(&probe.stdout).trim().parse().unwrap();
        assert!((measured - 3.5).abs() < 0.05, "measured {measured}");

        assert!(extract_reference(&video.to_string_lossy(), vec![], &out.to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Drives the real sidecar through the same code the app uses. Needs an
    /// installed engine, so it runs only when pointed at one:
    /// `SST_TTS_ROOT` (its HF_HOME parent) and `SST_TTS_PYTHON`.
    #[test]
    fn generates_through_the_sidecar() {
        let (Ok(root), Ok(python)) = (std::env::var("SST_TTS_ROOT"), std::env::var("SST_TTS_PYTHON"))
        else {
            eprintln!("SST_TTS_ROOT / SST_TTS_PYTHON not set; skipping");
            return;
        };
        let root = PathBuf::from(root);
        let out = root.join("out").join("rust-test.wav");
        let _ = std::fs::remove_file(&out);
        let slot = Mutex::new(None);
        let events = Mutex::new(Vec::new());
        let request = |text: &str, reference: Option<String>| TtsRequest {
            engine: "turbo".into(),
            text: text.into(),
            reference,
            seed: 5,
            exaggeration: 0.5,
            cfg_weight: 0.5,
            temperature: 0.8,
            output_path: out.to_string_lossy().into(),
            align_segments: None,
        };
        let on_event = |e: TtsEvent| events.lock().unwrap().push(e.event);

        let first = generate(&root, Path::new(&python), &slot, &request("Testing, one two. [chuckle]", None), &on_event)
            .expect("first line");
        assert!(first.duration > 0.5, "got {}", first.duration);
        assert!(out.is_file());
        assert!(events.lock().unwrap().contains(&"loading".to_string()));

        // The same sidecar answers the next request without reloading.
        events.lock().unwrap().clear();
        generate(&root, Path::new(&python), &slot, &request("And again.", None), &on_event)
            .expect("second line");
        assert!(events.lock().unwrap().is_empty(), "reloaded: {:?}", events.lock().unwrap());

        // A failure comes back as an error, and the sidecar survives it.
        let missing = Some(root.join("does-not-exist.wav").to_string_lossy().into_owned());
        assert!(generate(&root, Path::new(&python), &slot, &request("Nope.", missing), &on_event).is_err());
        generate(&root, Path::new(&python), &slot, &request("Still here.", None), &on_event)
            .expect("after a failure");
    }
}
