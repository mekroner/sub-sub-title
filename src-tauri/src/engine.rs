//! Installing Purfview's standalone Faster-Whisper-XXL, which the speech to
//! text feature shells out to.
//!
//! The engine is not something we can bundle: it is a 1.4 GB archive that
//! unpacks to about 4 GB. So it is fetched on first use, with real progress —
//! a wait this long behind a bare spinner is not an acceptable answer.
//!
//! Everything lives under the app's *local* data directory. Not the cache dir,
//! because a multi-gigabyte install is not a regenerable artifact and must
//! survive Storage Sense; not the roaming data dir, because a 4 GB roaming
//! profile breaks domain-joined machines.

use crate::error::{AppError, AppResult};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub const ENGINE_VERSION: &str = "r245.4";
pub const ENGINE_URL: &str = "https://github.com/Purfview/whisper-standalone-win/releases/download/Faster-Whisper-XXL/Faster-Whisper-XXL_r245.4_windows.7z";
/// From the release listing. Used for the pre-flight space check and the
/// "Download engine (1.4 GB)" label before any request has been made; the real
/// figure comes from Content-Length once the download starts.
pub const ENGINE_SIZE_BYTES: u64 = 1_424_256_246;
/// Left empty until someone computes it from a verified download. Empty means
/// the hash check is skipped — the size and magic-byte checks still run, so a
/// truncated or intercepted download is still caught.
const ENGINE_SHA256: &str = "";
const EXE_NAME: &str = "faster-whisper-xxl.exe";
/// Download plus the unpacked tree, with room to spare.
const REQUIRED_FREE_BYTES: u64 = 6 * 1024 * 1024 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
/// 7z's file magic. A captive portal serving an HTML sign-in page is the one
/// failure that otherwise surfaces as a baffling "unreadable archive" minutes
/// after the download finished.
const SEVENZ_MAGIC: [u8; 6] = [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineProgress {
    /// "downloading" | "verifying" | "extracting" | "locating" | "done"
    pub phase: String,
    /// 0.0..1.0, or -1.0 when unknown. Same convention as RenderProgress.
    pub fraction: f64,
    pub bytes_done: u64,
    pub bytes_total: u64,
    /// Bytes per second across the whole download; 0 when not applicable.
    pub speed_bps: u64,
    /// Seconds remaining, or -1.0 when unknown.
    pub eta_seconds: f64,
    /// The archive entry being written, while extracting; empty otherwise.
    pub detail: String,
}

impl EngineProgress {
    fn phase(phase: &str, fraction: f64) -> Self {
        Self {
            phase: phase.to_string(),
            fraction,
            bytes_done: 0,
            bytes_total: 0,
            speed_bps: 0,
            eta_seconds: -1.0,
            detail: String::new(),
        }
    }

    fn downloading(done: u64, total: u64, started: Instant) -> Self {
        let elapsed = started.elapsed().as_secs_f64();
        let speed = if elapsed > 0.5 {
            (done as f64 / elapsed) as u64
        } else {
            0
        };
        let fraction = if total > 0 {
            (done as f64 / total as f64).clamp(0.0, 1.0)
        } else {
            -1.0
        };
        let eta = if speed > 0 && total > done {
            (total - done) as f64 / speed as f64
        } else {
            -1.0
        };
        Self {
            phase: "downloading".to_string(),
            fraction,
            bytes_done: done,
            bytes_total: total,
            speed_bps: speed,
            eta_seconds: eta,
            detail: String::new(),
        }
    }

    fn extracting(done: u64, total: u64, detail: &str) -> Self {
        let fraction = if total > 0 {
            (done as f64 / total as f64).clamp(0.0, 1.0)
        } else {
            -1.0
        };
        Self {
            phase: "extracting".to_string(),
            fraction,
            bytes_done: done,
            bytes_total: total,
            speed_bps: 0,
            eta_seconds: -1.0,
            detail: detail.to_string(),
        }
    }
}

/// Written next to the unpacked engine once an install completes. The resolved
/// exe path is the single source of truth, so a user who installs the engine by
/// hand can be supported by writing this file and nothing else.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineManifest {
    pub version: String,
    pub exe_path: PathBuf,
    pub installed_at: u64,
    pub archive_sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub installed: bool,
    pub engine_version: String,
    pub exe_path: Option<String>,
    /// Bytes already downloaded, so the UI can offer "Resume (62%)".
    pub partial_bytes: u64,
    pub download_bytes: u64,
    /// 0 when the free space could not be determined.
    pub disk_free_bytes: u64,
    /// Whether the named model has already been fetched by a previous run.
    pub model_present: bool,
}

// --- Paths ------------------------------------------------------------------

fn local_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map_err(|e| AppError::msg(format!("No application data directory: {e}")))
}

pub fn engine_root(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = local_dir(app)?.join("engine");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Passed to the engine as --model_dir, so the models land somewhere we can
/// inspect rather than inside the versioned engine tree (which a future engine
/// upgrade would otherwise orphan).
pub fn models_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = local_dir(app)?.join("whisper-models");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn part_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = engine_root(app)?.join("download");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("Faster-Whisper-XXL.7z.part"))
}

fn archive_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(engine_root(app)?.join("download").join("Faster-Whisper-XXL.7z"))
}

/// Namespaced by version so bumping ENGINE_URL later never collides with an
/// install already on disk.
fn extract_root(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(engine_root(app)?.join(ENGINE_VERSION))
}

fn manifest_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(engine_root(app)?.join("engine.json"))
}

/// Returns the manifest only when the exe it names is still there, so deleting
/// the folder by hand self-heals into "not installed" rather than a confusing
/// failure at spawn time.
pub fn read_manifest(app: &AppHandle) -> Option<EngineManifest> {
    let path = manifest_path(app).ok()?;
    let bytes = std::fs::read(path).ok()?;
    let manifest: EngineManifest = serde_json::from_slice(&bytes).ok()?;
    manifest.exe_path.is_file().then_some(manifest)
}

fn write_manifest(app: &AppHandle, manifest: &EngineManifest) -> AppResult<()> {
    std::fs::write(manifest_path(app)?, serde_json::to_vec_pretty(manifest)?)?;
    Ok(())
}

// --- Status -----------------------------------------------------------------

/// Whether a model directory for `model` already exists. The engine names them
/// `faster-whisper-<model>`; a partial download leaves the directory in place,
/// so also require it to be non-empty.
fn model_present(app: &AppHandle, model: &str) -> bool {
    let Ok(dir) = models_dir(app) else {
        return false;
    };
    let candidate = dir.join(format!("faster-whisper-{model}"));
    std::fs::read_dir(candidate)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

pub fn status(app: &AppHandle, model: &str) -> EngineStatus {
    let manifest = read_manifest(app);
    let partial = part_path(app)
        .map(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
        .unwrap_or(0);
    EngineStatus {
        installed: manifest.is_some(),
        engine_version: ENGINE_VERSION.to_string(),
        exe_path: manifest.map(|m| m.exe_path.to_string_lossy().into_owned()),
        partial_bytes: partial,
        download_bytes: ENGINE_SIZE_BYTES,
        disk_free_bytes: local_dir(app).map(|d| free_space(&d)).unwrap_or(0),
        model_present: model_present(app, model),
    }
}

#[cfg(windows)]
fn free_space(path: &Path) -> u64 {
    use std::os::windows::ffi::OsStrExt;
    // GetDiskFreeSpaceExW wants a directory that exists; walk up until one does,
    // since the engine directory may not have been created yet.
    let mut probe = path.to_path_buf();
    while !probe.is_dir() {
        match probe.parent() {
            Some(parent) => probe = parent.to_path_buf(),
            None => return 0,
        }
    }
    let wide: Vec<u16> = probe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut free: u64 = 0;
    // SAFETY: `wide` is a NUL-terminated UTF-16 path that outlives the call, and
    // the two output pointers are valid for the duration.
    let ok = unsafe {
        windows_get_disk_free_space(wide.as_ptr(), &mut free as *mut u64, std::ptr::null_mut())
    };
    if ok == 0 {
        0
    } else {
        free
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    #[link_name = "GetDiskFreeSpaceExW"]
    fn windows_get_disk_free_space(
        directory: *const u16,
        free_bytes_available_to_caller: *mut u64,
        total_number_of_bytes: *mut u64,
    ) -> i32;
}

#[cfg(not(windows))]
fn free_space(_path: &Path) -> u64 {
    0
}

fn human_bytes(bytes: u64) -> String {
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    let b = bytes as f64;
    if b >= GB {
        format!("{:.1} GB", b / GB)
    } else {
        format!("{:.0} MB", b / MB)
    }
}

// --- Install ----------------------------------------------------------------

/// Download, verify, unpack and locate the engine. Idempotent: returns straight
/// away when a previous install is still intact.
pub async fn install(app: &AppHandle, cancelled: Arc<AtomicBool>) -> AppResult<()> {
    if read_manifest(app).is_some() {
        return Ok(());
    }

    let free = free_space(&local_dir(app)?);
    if free > 0 && free < REQUIRED_FREE_BYTES {
        // Refusing up front beats a twenty-minute download that ends in
        // "disk full".
        return Err(AppError::msg(format!(
            "There is not enough disk space for the transcription engine. It needs about \
             1.4 GB to download and 4 GB once unpacked, but only {} is free.",
            human_bytes(free)
        )));
    }

    let archive = archive_path(app)?;
    if !archive.is_file() {
        download(app, &cancelled).await?;
    }

    let exe = {
        let app = app.clone();
        let archive = archive.clone();
        let root = extract_root(app.app_handle())?;
        let cancelled = cancelled.clone();
        // sevenz-rust2 is entirely synchronous, and unpacking 4 GB takes
        // minutes; keep it off the async runtime's threads.
        tauri::async_runtime::spawn_blocking(move || extract(&app, &archive, &root, &cancelled))
            .await
            .map_err(|e| AppError::msg(format!("Unpacking the engine failed: {e}")))??
    };

    let _ = app.emit("engine-progress", EngineProgress::phase("locating", -1.0));
    write_manifest(
        app,
        &EngineManifest {
            version: ENGINE_VERSION.to_string(),
            exe_path: exe,
            installed_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            archive_sha256: ENGINE_SHA256.to_string(),
        },
    )?;

    // The archive is 1.4 GB of dead weight once unpacked.
    let _ = std::fs::remove_file(&archive);
    let _ = app.emit("engine-progress", EngineProgress::phase("done", 1.0));
    Ok(())
}

async fn download(app: &AppHandle, cancelled: &AtomicBool) -> AppResult<()> {
    let part = part_path(app)?;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        // Per-read stall detection rather than an overall cap: a whole-request
        // timeout would guarantee failure on a 1.4 GB body.
        .read_timeout(Duration::from_secs(60))
        .build()?;

    let mut written = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let mut request = client.get(ENGINE_URL);
    if written > 0 {
        request = request.header("Range", format!("bytes={written}-"));
    }

    let response = request.send().await.map_err(|e| {
        AppError::msg(format!(
            "Could not reach GitHub to download the transcription engine: {e}. \
             Check your internet connection and try again."
        ))
    })?;

    let status = response.status();
    let resuming = status == reqwest::StatusCode::PARTIAL_CONTENT;
    if !resuming {
        // The server ignored the Range header, so start over.
        written = 0;
    }
    if !status.is_success() {
        return Err(AppError::msg(if status.as_u16() == 404 {
            "The engine download is no longer available at the expected address. \
             The app may need an update."
                .to_string()
        } else {
            format!("The engine download failed (HTTP {status}).")
        }));
    }

    let total = response
        .content_length()
        .map(|len| len + written)
        .unwrap_or(0);

    let mut file = std::io::BufWriter::with_capacity(
        1 << 20,
        std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(resuming)
            .truncate(!resuming)
            .open(&part)?,
    );

    let started = Instant::now();
    let mut last_emit = Instant::now();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancelled.load(Ordering::SeqCst) {
            // Keep the .part file so the next attempt resumes.
            let _ = file.flush();
            return Err(AppError::msg("The engine download was cancelled."));
        }
        let chunk = chunk.map_err(|e| {
            AppError::msg(format!(
                "The engine download was interrupted at {} of {}: {e}. \
                 Press Download again to resume where it left off.",
                human_bytes(written),
                human_bytes(total)
            ))
        })?;
        file.write_all(&chunk).map_err(disk_error)?;
        written += chunk.len() as u64;
        if last_emit.elapsed() >= PROGRESS_INTERVAL {
            last_emit = Instant::now();
            let _ = app.emit(
                "engine-progress",
                EngineProgress::downloading(written, total, started),
            );
        }
    }
    file.flush().map_err(disk_error)?;
    drop(file);

    verify(app, &part, written, total)?;
    std::fs::rename(&part, archive_path(app)?)?;
    Ok(())
}

fn disk_error(e: std::io::Error) -> AppError {
    if e.kind() == std::io::ErrorKind::StorageFull {
        AppError::msg(
            "There is not enough disk space for the transcription engine. It needs about \
             1.4 GB to download and 4 GB once unpacked.",
        )
    } else {
        AppError::from(e)
    }
}

/// Magic bytes, then length, then hash — cheapest and most diagnostic first.
/// The `.part` file is discarded on any failure, because a damaged archive that
/// survives would be resumed into forever.
fn verify(app: &AppHandle, part: &Path, written: u64, total: u64) -> AppResult<()> {
    let _ = app.emit("engine-progress", EngineProgress::phase("verifying", -1.0));

    let mut magic = [0u8; 6];
    let read = std::fs::File::open(part).and_then(|mut f| f.read(&mut magic));
    if read.map(|n| n < 6).unwrap_or(true) || magic != SEVENZ_MAGIC {
        let _ = std::fs::remove_file(part);
        return Err(AppError::msg(
            "The download did not return the engine file — a network sign-in page may \
             have interfered. Try again on a different network.",
        ));
    }

    if total > 0 && written != total {
        let _ = std::fs::remove_file(part);
        return Err(AppError::msg(
            "The engine download is incomplete and was discarded. Please try again.",
        ));
    }

    if !ENGINE_SHA256.is_empty() {
        let actual = sha256_file(part)?;
        if !actual.eq_ignore_ascii_case(ENGINE_SHA256) {
            let _ = std::fs::remove_file(part);
            return Err(AppError::msg(
                "The downloaded engine failed its integrity check and was discarded. \
                 Please try again.",
            ));
        }
    }
    Ok(())
}

fn sha256_file(path: &Path) -> AppResult<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Reject anything that would escape the destination directory: absolute paths,
/// drive prefixes, and `..`. 7z entry names come from the archive, so they are
/// untrusted input.
fn safe_relative(name: &str) -> Option<PathBuf> {
    let normalised = name.replace('\\', "/");
    let path = Path::new(&normalised);
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            // A lone "." is harmless noise; everything else is an escape.
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

fn extract(
    app: &AppHandle,
    archive: &Path,
    dest: &Path,
    cancelled: &AtomicBool,
) -> AppResult<PathBuf> {
    let unpack_failed = |e: String| {
        AppError::msg(format!(
            "Could not unpack the transcription engine: {e}\n\nYou can download it \
             yourself from {ENGINE_URL} and set the engine path in Settings."
        ))
    };

    std::fs::create_dir_all(dest)?;
    let mut reader = sevenz_rust2::ArchiveReader::open(archive, sevenz_rust2::Password::empty())
        .map_err(|e| unpack_failed(e.to_string()))?;

    // Byte-weighted, not entry-counted: the archive is a handful of very large
    // DLLs plus thousands of tiny files, so counting entries would sit at 90%
    // almost immediately and then stall.
    let total: u64 = reader.archive().files.iter().map(|f| f.size()).sum();
    let mut done: u64 = 0;
    let mut last_emit = Instant::now();
    let mut cancelled_during = false;
    // Writing to disk can fail for reasons sevenz-rust2 has no vocabulary for
    // (a full disk, antivirus locking a file). Carry ours out separately rather
    // than forcing it into the crate's error type.
    let mut write_error: Option<AppError> = None;

    let result = reader.for_each_entries(|entry, stream| {
        if cancelled.load(Ordering::SeqCst) {
            cancelled_during = true;
            return Ok(false);
        }
        let Some(relative) = safe_relative(entry.name()) else {
            // Skip rather than fail: one hostile name should not cost the user
            // the whole 1.4 GB download.
            return Ok(true);
        };
        let out = dest.join(relative);
        let written = (|| -> std::io::Result<()> {
            if entry.is_directory() {
                std::fs::create_dir_all(&out)?;
            } else {
                if let Some(parent) = out.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let mut file = std::io::BufWriter::new(std::fs::File::create(&out)?);
                std::io::copy(stream, &mut file)?;
                file.flush()?;
            }
            Ok(())
        })();
        if let Err(e) = written {
            write_error = Some(if e.kind() == std::io::ErrorKind::StorageFull {
                AppError::msg(
                    "Ran out of disk space while unpacking the transcription engine. \
                     About 4 GB is needed.",
                )
            } else {
                AppError::msg(format!(
                    "Could not write {}: {e}",
                    out.file_name().unwrap_or_default().to_string_lossy()
                ))
            });
            return Ok(false);
        }
        done += entry.size();
        if last_emit.elapsed() >= PROGRESS_INTERVAL {
            last_emit = Instant::now();
            let _ = app.emit(
                "engine-progress",
                EngineProgress::extracting(done, total, entry.name()),
            );
        }
        Ok(true)
    });

    // A half-unpacked tree is worse than none: it would look installed to a
    // casual glance and fail at spawn time.
    if cancelled_during {
        let _ = std::fs::remove_dir_all(dest);
        return Err(AppError::msg("Unpacking the engine was cancelled."));
    }
    if let Some(e) = write_error {
        let _ = std::fs::remove_dir_all(dest);
        return Err(e);
    }
    result.map_err(|e| unpack_failed(e.to_string()))?;

    locate_exe(dest).ok_or_else(|| {
        AppError::msg(format!(
            "The engine unpacked but {EXE_NAME} is missing. Antivirus software may have \
             quarantined it — allow the folder and try again."
        ))
    })
}

/// Breadth-first so the shallowest match wins, and depth-capped because the
/// unpacked tree contains thousands of directories. The archive's top-level
/// folder name is not guaranteed stable across releases, hence the search
/// rather than a hardcoded path.
fn locate_exe(root: &Path) -> Option<PathBuf> {
    let mut level = vec![root.to_path_buf()];
    for _ in 0..4 {
        let mut next = Vec::new();
        for dir in level {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    next.push(path);
                } else if path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.eq_ignore_ascii_case(EXE_NAME))
                {
                    return Some(path);
                }
            }
        }
        if next.is_empty() {
            return None;
        }
        level = next;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_relative_keeps_ordinary_names() {
        assert_eq!(
            safe_relative("Faster-Whisper-XXL/faster-whisper-xxl.exe"),
            Some(PathBuf::from("Faster-Whisper-XXL").join("faster-whisper-xxl.exe"))
        );
        // 7z archives built on Windows use backslashes.
        assert_eq!(
            safe_relative(r"Faster-Whisper-XXL\_xxl_data\lib.dll"),
            Some(
                PathBuf::from("Faster-Whisper-XXL")
                    .join("_xxl_data")
                    .join("lib.dll")
            )
        );
        assert_eq!(
            safe_relative("./a/./b.txt"),
            Some(PathBuf::from("a").join("b.txt"))
        );
    }

    #[test]
    fn safe_relative_rejects_escapes() {
        assert_eq!(safe_relative(r"..\..\evil.exe"), None);
        assert_eq!(safe_relative("../evil.exe"), None);
        assert_eq!(safe_relative(r"C:\evil.exe"), None);
        assert_eq!(safe_relative("/etc/passwd"), None);
        assert_eq!(safe_relative("a/../../b"), None);
        assert_eq!(safe_relative(""), None);
    }

    #[test]
    fn human_bytes_reads_naturally() {
        assert_eq!(human_bytes(1_424_256_246), "1.3 GB");
        assert_eq!(human_bytes(50 * 1024 * 1024), "50 MB");
    }
}
