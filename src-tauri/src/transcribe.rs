//! Speech to text: runs Faster-Whisper-XXL over the project's video and hands
//! the frontend the SRT it produces.
//!
//! Installing the engine is a separate command from transcribing, so the UI —
//! not the backend — owns the "this costs 1.4 GB" decision. See `engine.rs`.

use crate::engine::{self, EngineStatus};
use crate::error::{AppError, AppResult};
use crate::media::quiet_command;
use serde::Serialize;
use std::io::{BufReader, Read};
use std::path::Path;
use std::process::{Child, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const DEFAULT_MODEL: &str = "medium";
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
/// How many output records to keep for the failure message.
const TAIL_LINES: usize = 40;

/// Holds the running engine so it can be killed mid-transcription, and the
/// cancel flag the download and unpack loops poll. Mirrors `RenderState`.
#[derive(Default)]
pub struct TranscribeState {
    child: Arc<Mutex<Option<Child>>>,
    cancelled: Arc<AtomicBool>,
    /// Stops a second install racing the first.
    installing: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeProgress {
    /// "starting" | "modelDownload" | "vad" | "transcribing"
    pub phase: String,
    /// 0.0..1.0, or -1.0 when unknown. Same convention as RenderProgress.
    pub fraction: f64,
    /// The engine's latest output, for a status line under the bar.
    pub message: String,
}

#[tauri::command]
pub fn transcribe_status(app: AppHandle, model: Option<String>) -> EngineStatus {
    engine::status(&app, model.as_deref().unwrap_or(DEFAULT_MODEL))
}

#[tauri::command]
pub fn cancel_transcribe(state: tauri::State<'_, TranscribeState>) -> AppResult<()> {
    state.cancelled.store(true, Ordering::SeqCst);
    let mut guard = state
        .child
        .lock()
        .map_err(|_| AppError::msg("Transcription lock poisoned."))?;
    if let Some(child) = guard.as_mut() {
        let _ = child.kill();
    }
    // The child is left in place so the wait loop can reap it.
    Ok(())
}

#[tauri::command]
pub async fn install_engine(
    app: AppHandle,
    state: tauri::State<'_, TranscribeState>,
    model: Option<String>,
) -> AppResult<EngineStatus> {
    if state.installing.swap(true, Ordering::SeqCst) {
        return Err(AppError::msg("The engine is already downloading."));
    }
    state.cancelled.store(false, Ordering::SeqCst);
    let result = engine::install(&app, state.cancelled.clone()).await;
    state.installing.store(false, Ordering::SeqCst);
    state.cancelled.store(false, Ordering::SeqCst);
    result?;
    Ok(engine::status(
        &app,
        model.as_deref().unwrap_or(DEFAULT_MODEL),
    ))
}

#[tauri::command]
pub async fn transcribe_video(
    app: AppHandle,
    state: tauri::State<'_, TranscribeState>,
    video_path: String,
    language: Option<String>,
    model: Option<String>,
) -> AppResult<String> {
    let exe = engine::resolve_exe(&app).ok_or_else(|| {
        AppError::msg("The transcription engine is not installed yet. Download it first.")
    })?;
    if !Path::new(&video_path).is_file() {
        return Err(AppError::msg(format!("File not found: {video_path}")));
    }

    let model = model.unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let models = engine::models_dir(&app)?;
    // A fresh directory per run, so the finished .srt can be found by looking
    // rather than by predicting the name the engine sanitised it into.
    let out_dir = engine::engine_root(&app)?.join("out").join(run_id());
    std::fs::create_dir_all(&out_dir)?;

    state.cancelled.store(false, Ordering::SeqCst);
    let _ = app.emit(
        "transcribe-progress",
        TranscribeProgress {
            phase: "starting".to_string(),
            fraction: -1.0,
            message: String::new(),
        },
    );

    let mut command = quiet_command(&exe.to_string_lossy());
    // The media path must come FIRST. --output_format is variadic, so a path
    // placed after it is silently swallowed as another format name.
    command.arg(&video_path).args(["--model", &model]);
    // Auto-detect omits the flag entirely rather than passing a literal "auto".
    if let Some(code) = language.as_deref().filter(|c| !c.trim().is_empty()) {
        command.args(["--language", code]);
    }
    command
        .args(["--output_format", "srt"])
        .arg("--output_dir")
        .arg(&out_dir)
        .arg("--model_dir")
        .arg(&models)
        // -pp prints the progress bar; --beep_off stops it beeping at the user
        // when it finishes.
        .args(["-pp", "--beep_off"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            AppError::msg(
                "Windows blocked the transcription engine from starting. Allow it in your \
                 antivirus settings, then try again.",
            )
        } else {
            AppError::msg(format!("Could not start the transcription engine: {e}"))
        }
    })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let mut guard = state
            .child
            .lock()
            .map_err(|_| AppError::msg("Transcription lock poisoned."))?;
        *guard = Some(child);
    }

    // Both pipes are drained on their own threads: even though -pp keeps stdout
    // nearly silent, an unread pipe that fills would deadlock the child.
    let out_app = app.clone();
    let stdout_thread = std::thread::spawn(move || match stdout {
        Some(stdout) => watch_output(&out_app, stdout),
        None => Vec::new(),
    });
    let err_app = app.clone();
    let stderr_thread = std::thread::spawn(move || match stderr {
        Some(stderr) => watch_output(&err_app, stderr),
        None => Vec::new(),
    });

    // Poll rather than block on wait(), so the lock stays free for cancel.
    let child_handle = state.child.clone();
    let status: Option<ExitStatus> = tauri::async_runtime::spawn_blocking(move || loop {
        {
            let Ok(mut guard) = child_handle.lock() else {
                return None;
            };
            let Some(child) = guard.as_mut() else {
                return None;
            };
            match child.try_wait() {
                Ok(Some(status)) => return Some(status),
                Ok(None) => {}
                Err(_) => return None,
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    })
    .await
    .map_err(|e| AppError::msg(format!("The transcription task failed: {e}")))?;

    let mut tail = stdout_thread.join().unwrap_or_default();
    tail.extend(stderr_thread.join().unwrap_or_default());
    let tail = tail.join("\n");

    if let Ok(mut guard) = state.child.lock() {
        *guard = None;
    }

    if state.cancelled.swap(false, Ordering::SeqCst) {
        let _ = std::fs::remove_dir_all(&out_dir);
        return Err(AppError::msg("The transcription was cancelled."));
    }

    match status {
        Some(s) if s.success() => {}
        Some(s) => {
            let _ = std::fs::remove_dir_all(&out_dir);
            return Err(exit_error(&model, &s.to_string(), &tail));
        }
        None => {
            let _ = std::fs::remove_dir_all(&out_dir);
            return Err(AppError::msg(format!(
                "The transcription stopped unexpectedly.\n{tail}"
            )));
        }
    }

    let srt = std::fs::read_dir(&out_dir)?
        .flatten()
        .map(|entry| entry.path())
        .find(|p| {
            p.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("srt"))
        })
        .ok_or_else(|| {
            AppError::msg(format!(
                "The engine finished but produced no subtitle file.\n{tail}"
            ))
        })?;
    let text = crate::files::decode_text(&std::fs::read(&srt)?);
    let _ = std::fs::remove_dir_all(&out_dir);
    Ok(text)
}

/// The engine's own failures are more actionable than its exit code, so name
/// the two we can recognise from its output.
fn exit_error(model: &str, status: &str, tail: &str) -> AppError {
    let lower = tail.to_ascii_lowercase();
    if lower.contains("download") && (lower.contains("error") || lower.contains("failed")) {
        return AppError::msg(format!(
            "Could not download the {model} speech model. Check your internet connection \
             and try again.\n{tail}"
        ));
    }
    if lower.contains("out of memory") || lower.contains("cuda") {
        return AppError::msg(format!(
            "The transcription engine ran out of graphics memory. Close other GPU-heavy \
             apps and try again.\n{tail}"
        ));
    }
    AppError::msg(format!(
        "The transcription engine exited with {status}.\n{tail}"
    ))
}

fn run_id() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_else(|_| "run".to_string())
}

/// Reads one of the engine's pipes, emitting progress and returning the tail
/// for the failure message.
fn watch_output<R: Read>(app: &AppHandle, source: R) -> Vec<String> {
    let mut tail: Vec<String> = Vec::new();
    let mut phase = Phase::Unknown;
    let mut fraction = -1.0;
    // Backdated so the first record emits immediately rather than 250 ms in.
    // `checked_sub` because an Instant cannot go before the platform's epoch.
    let mut last_emit = Instant::now()
        .checked_sub(PROGRESS_INTERVAL)
        .unwrap_or_else(Instant::now);

    read_records(source, |record| {
        let record = record.trim();
        if record.is_empty() {
            return;
        }
        tail.push(record.to_string());
        if tail.len() > TAIL_LINES {
            tail.remove(0);
        }

        match classify(record) {
            Phase::Unknown => {}
            // Once transcription has started, a stray "download" in the output
            // is noise — never go back to reporting a model download.
            Phase::ModelDownload if phase == Phase::Transcribing => {}
            next => phase = next,
        }
        if let Some(parsed) = parse_percent(record) {
            fraction = parsed;
        }

        if last_emit.elapsed() >= PROGRESS_INTERVAL {
            last_emit = Instant::now();
            let _ = app.emit(
                "transcribe-progress",
                TranscribeProgress {
                    phase: phase.as_str().to_string(),
                    fraction,
                    message: record.to_string(),
                },
            );
        }
    });
    tail
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    ModelDownload,
    Vad,
    Transcribing,
    Unknown,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Phase::ModelDownload => "modelDownload",
            Phase::Vad => "vad",
            Phase::Transcribing => "transcribing",
            Phase::Unknown => "starting",
        }
    }
}

/// Splitting on `\n` alone would block until the process exits: the engine's
/// progress bar is a single line rewritten with carriage returns, so `\r` ends
/// a record just as much as `\n` does.
fn read_records<R: Read>(source: R, mut on_record: impl FnMut(&str)) {
    let mut source = BufReader::new(source);
    let mut buffer: Vec<u8> = Vec::with_capacity(4096);
    let mut byte = [0u8; 1];
    while matches!(source.read(&mut byte), Ok(1)) {
        if byte[0] == b'\r' || byte[0] == b'\n' {
            if !buffer.is_empty() {
                on_record(&String::from_utf8_lossy(&buffer));
                buffer.clear();
            }
        } else if buffer.len() < 8192 {
            // Guard against an output stream that never terminates a record.
            buffer.push(byte[0]);
        }
    }
    if !buffer.is_empty() {
        on_record(&String::from_utf8_lossy(&buffer));
    }
}

/// The first percentage on the record. A progress bar puts its percentage
/// before the `|####|` body, and the body itself contains no `%`, so the first
/// match is the one that means progress.
fn parse_percent(record: &str) -> Option<f64> {
    let bytes = record.as_bytes();
    let end = bytes.iter().position(|&c| c == b'%')?;
    // Accept a decimal point as well as digits. The engine prints whole numbers
    // today, but stopping at the '.' in "43.5%" would read it as 5%, which is
    // a worse failure than not parsing at all.
    let start = bytes[..end]
        .iter()
        .rposition(|&c| !c.is_ascii_digit() && c != b'.')
        .map_or(0, |p| p + 1);
    if start == end {
        return None;
    }
    let value: f64 = record[start..end].parse().ok()?;
    // Rejects a rate like "250% faster" as well as outright nonsense.
    (value <= 100.0).then_some(value / 100.0)
}

fn classify(record: &str) -> Phase {
    let lower = record.to_ascii_lowercase();
    if lower.contains("download")
        || lower.contains("huggingface")
        || lower.contains("fetching")
        || lower.contains(".bin")
    {
        Phase::ModelDownload
    } else if lower.contains("vad") || lower.contains("silero") {
        Phase::Vad
    } else if lower.contains("transcrib")
        || lower.contains("inference")
        || lower.contains("audio seconds/s")
        || record.contains('|')
    {
        Phase::Transcribing
    } else {
        Phase::Unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured verbatim from `faster-whisper-xxl.exe r245.4 … -pp`. Every line
    /// arrives on stdout — stderr stays empty — and each ends `\r\n`, with the
    /// progress line ending `\r\r\n`.
    const REAL_OUTPUT: &str = concat!(
        "\r\n",
        "Standalone Faster-Whisper-XXL r245.4 running on: CUDA\r\n",
        "\r\n",
        "Starting to process: C:/tmp/probe.wav\r\n",
        "\r\n",
        "Starting sequential faster-whisper inference.\r\n",
        "\r\n",
        "100% | 45/45 | 00:00<<00:00 | 111.58 audio seconds/s\r\r\n",
        "\r\n",
        "Transcription speed: 106.8 audio seconds/s\r\n",
        "\r\n",
        "Operation finished in:  0:00:02.825 \r\n",
    );

    #[test]
    fn parses_the_engines_real_progress_line() {
        // Note the ` | ` separators — not a tqdm `|####|` bar, which is what
        // this parser was originally written against.
        assert_eq!(
            parse_percent("100% | 45/45 | 00:00<<00:00 | 111.58 audio seconds/s"),
            Some(1.0)
        );
        assert_eq!(
            parse_percent(" 43% | 129/300 | 00:31<<00:41 | 4.1 audio seconds/s"),
            Some(0.43)
        );
        assert_eq!(parse_percent("  0% | 0/300"), Some(0.0));
        // A decimal must not be truncated to its fractional digits.
        assert_eq!(parse_percent("43.5% | 130/300"), Some(0.435));
    }

    #[test]
    fn ignores_records_without_a_usable_percentage() {
        assert_eq!(parse_percent("Transcription speed: 106.8 audio seconds/s"), None);
        assert_eq!(parse_percent("Detected language 'en'"), None);
        assert_eq!(parse_percent("no digits here %"), None);
        assert_eq!(parse_percent("speed 250% faster"), None);
    }

    #[test]
    fn classifies_the_engines_real_output() {
        assert_eq!(
            classify("100% | 45/45 | 00:00<<00:00 | 111.58 audio seconds/s"),
            Phase::Transcribing
        );
        assert_eq!(
            classify("Starting sequential faster-whisper inference."),
            Phase::Transcribing
        );
        assert_eq!(
            classify("Transcription speed: 106.8 audio seconds/s"),
            Phase::Transcribing
        );
        assert_eq!(
            classify("Standalone Faster-Whisper-XXL r245.4 running on: CUDA"),
            Phase::Unknown
        );
        assert_eq!(classify("VAD filter removed 00:12.340 of audio"), Phase::Vad);
        assert_eq!(
            classify("Downloading model.bin: 12% | 180M/1.5G"),
            Phase::ModelDownload
        );
    }

    #[test]
    fn drives_progress_from_the_engines_real_output() {
        let mut phase = Phase::Unknown;
        let mut fraction = -1.0;
        read_records(REAL_OUTPUT.as_bytes(), |record| {
            let record = record.trim();
            if record.is_empty() {
                return;
            }
            match classify(record) {
                Phase::Unknown => {}
                next => phase = next,
            }
            if let Some(parsed) = parse_percent(record) {
                fraction = parsed;
            }
        });
        assert_eq!(phase, Phase::Transcribing);
        assert_eq!(fraction, 1.0);
    }

    #[test]
    fn read_records_splits_on_carriage_returns() {
        let input = "first\rsecond\nthird\r\nfourth";
        let mut seen = Vec::new();
        read_records(input.as_bytes(), |record| seen.push(record.to_string()));
        assert_eq!(seen, vec!["first", "second", "third", "fourth"]);
    }

    #[test]
    fn read_records_yields_a_bar_as_it_is_rewritten() {
        // The shape that would otherwise sit at 0% until the process exits.
        let input = "  0%|  | 0/2\r 50%|# | 1/2\r100%|##| 2/2\r";
        let mut fractions = Vec::new();
        read_records(input.as_bytes(), |record| {
            fractions.push(parse_percent(record))
        });
        assert_eq!(fractions, vec![Some(0.0), Some(0.5), Some(1.0)]);
    }
}
