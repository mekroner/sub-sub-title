//! Phase 7: burn an .ass subtitle file into the video with ffmpeg.

use crate::error::{AppError, AppResult};
use crate::media::{ffmpeg_bin, quiet_command};
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

/// Holds the running ffmpeg process so it can be cancelled mid-encode.
#[derive(Default)]
pub struct RenderState {
    child: Arc<Mutex<Option<Child>>>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderProgress {
    /// 0.0..1.0, or -1.0 when the total duration is unknown.
    pub fraction: f64,
    pub time_seconds: f64,
    pub speed: String,
}

#[tauri::command]
pub fn cancel_render(state: tauri::State<'_, RenderState>) -> AppResult<()> {
    state.cancelled.store(true, Ordering::SeqCst);
    let mut guard = state
        .child
        .lock()
        .map_err(|_| AppError::msg("Render lock poisoned."))?;
    if let Some(child) = guard.as_mut() {
        let _ = child.kill();
    }
    // The child is left in place so the wait loop can reap it.
    Ok(())
}

/// Escaping a Windows path inside ffmpeg's `subtitles=` filter is famously
/// fragile (drive colons, backslashes, quotes, commas). Rather than escape, copy
/// the subtitle file to a scratch directory under a fixed ASCII name and run
/// ffmpeg with that directory as its working directory.
fn stage_subtitles(app: &AppHandle, ass_path: &str) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::msg(format!("No cache directory: {e}")))?
        .join("render");
    std::fs::create_dir_all(&dir)?;
    let staged = dir.join("subs.ass");
    std::fs::copy(ass_path, &staged)
        .map_err(|e| AppError::msg(format!("Could not stage the subtitle file: {e}")))?;
    Ok(dir)
}

#[tauri::command]
pub async fn render_burn_in(
    app: AppHandle,
    state: tauri::State<'_, RenderState>,
    video_path: String,
    ass_path: String,
    output_path: String,
    duration: f64,
    crf: Option<u32>,
) -> AppResult<()> {
    if PathBuf::from(&output_path) == PathBuf::from(&video_path) {
        return Err(AppError::msg(
            "The output file would overwrite the source video. Choose another name.",
        ));
    }

    let work_dir = stage_subtitles(&app, &ass_path)?;
    let crf = crf.unwrap_or(18).clamp(0, 51);
    state.cancelled.store(false, Ordering::SeqCst);

    let mut child = quiet_command(&ffmpeg_bin())
        .current_dir(&work_dir)
        .args(["-hide_banner", "-nostdin", "-y", "-i"])
        .arg(&video_path)
        // Relative name only; see stage_subtitles above.
        .args(["-vf", "subtitles=subs.ass"])
        .args([
            "-c:v", "libx264", "-crf", &crf.to_string(), "-preset", "medium",
        ])
        .args(["-c:a", "copy", "-movflags", "+faststart"])
        .args(["-nostats", "-progress", "pipe:1"])
        .arg(&output_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::msg(format!("Could not start ffmpeg: {e}")))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::msg("ffmpeg produced no progress stream."))?;
    let stderr = child.stderr.take();

    {
        let mut guard = state
            .child
            .lock()
            .map_err(|_| AppError::msg("Render lock poisoned."))?;
        *guard = Some(child);
    }

    // ffmpeg writes `key=value` lines to stdout under -progress.
    let progress_app = app.clone();
    let progress_thread = std::thread::spawn(move || {
        let mut speed = String::from("?");
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            match key.trim() {
                "speed" => speed = value.trim().to_string(),
                // Despite the name, out_time_ms carries microseconds.
                "out_time_us" | "out_time_ms" => {
                    if let Ok(us) = value.trim().parse::<f64>() {
                        let seconds = us / 1_000_000.0;
                        let fraction = if duration > 0.0 {
                            (seconds / duration).clamp(0.0, 1.0)
                        } else {
                            -1.0
                        };
                        let _ = progress_app.emit(
                            "render-progress",
                            RenderProgress {
                                fraction,
                                time_seconds: seconds,
                                speed: speed.clone(),
                            },
                        );
                    }
                }
                _ => {}
            }
        }
    });

    // Drain stderr concurrently so a chatty ffmpeg cannot fill the pipe buffer
    // and deadlock. Keep the tail for the error message.
    let stderr_thread = std::thread::spawn(move || {
        let mut tail: Vec<String> = Vec::new();
        if let Some(stderr) = stderr {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                tail.push(line);
                if tail.len() > 20 {
                    tail.remove(0);
                }
            }
        }
        tail.join("\n")
    });

    // Poll rather than block on wait(), so the lock stays free for cancel_render.
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
        std::thread::sleep(std::time::Duration::from_millis(100));
    })
    .await
    .map_err(|e| AppError::msg(format!("Render task failed: {e}")))?;

    let _ = progress_thread.join();
    let stderr_tail = stderr_thread.join().unwrap_or_default();

    if let Ok(mut guard) = state.child.lock() {
        *guard = None;
    }

    if state.cancelled.swap(false, Ordering::SeqCst) {
        return Err(AppError::msg("The render was cancelled."));
    }

    match status {
        Some(s) if s.success() => Ok(()),
        Some(s) => Err(AppError::msg(format!(
            "ffmpeg exited with {s}.\n{stderr_tail}"
        ))),
        None => Err(AppError::msg(format!(
            "The render stopped unexpectedly.\n{stderr_tail}"
        ))),
    }
}
