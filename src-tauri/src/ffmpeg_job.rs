//! One long ffmpeg encode at a time, with progress and cancel: the run loop
//! shared by the burn-in render and the Edit tab's bake.

use crate::error::{AppError, AppResult};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Holds the running ffmpeg process so it can be cancelled mid-encode.
#[derive(Default)]
pub struct FfmpegJob {
    child: Arc<Mutex<Option<Child>>>,
    /// Also set by work done before ffmpeg starts, so a cancel then is seen.
    pub cancelled: Arc<AtomicBool>,
}

/// What `-progress` reports, as the caller's event wants it.
pub struct Progress {
    /// 0.0..1.0, or -1.0 when the total duration is unknown.
    pub fraction: f64,
    pub time_seconds: f64,
    pub speed: String,
}

impl FfmpegJob {
    /// Kills the running ffmpeg, if any. The child is left in place so the
    /// wait loop can reap it.
    pub fn cancel(&self, noun: &str) -> AppResult<()> {
        self.cancelled.store(true, Ordering::SeqCst);
        let mut guard = self
            .child
            .lock()
            .map_err(|_| AppError::msg(format!("{} lock poisoned.", capitalise(noun))))?;
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
        }
        Ok(())
    }

    /// Clears a cancel left over from an earlier run.
    pub fn reset(&self) {
        self.cancelled.store(false, Ordering::SeqCst);
    }

    /// True once, if a cancel was asked for since the last reset.
    pub fn take_cancelled(&self) -> bool {
        self.cancelled.swap(false, Ordering::SeqCst)
    }

    /// Runs `command` (which must already carry `-progress pipe:1`) to the end,
    /// calling `on_progress` as it goes. `noun` names the job in errors: "render",
    /// "bake".
    pub async fn run(
        &self,
        mut command: Command,
        duration: f64,
        noun: &str,
        on_progress: impl Fn(Progress) + Send + 'static,
    ) -> AppResult<()> {
        let mut child = command
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
            let mut guard = self
                .child
                .lock()
                .map_err(|_| AppError::msg(format!("{} lock poisoned.", capitalise(noun))))?;
            *guard = Some(child);
        }

        // ffmpeg writes `key=value` lines to stdout under -progress.
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
                            on_progress(Progress {
                                fraction,
                                time_seconds: seconds,
                                speed: speed.clone(),
                            });
                        }
                    }
                    _ => {}
                }
            }
        });

        // Drain stderr concurrently so a chatty ffmpeg cannot fill the pipe
        // buffer and deadlock. Keep the tail for the error message.
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

        // Poll rather than block on wait(), so the lock stays free for cancel.
        let child_handle = self.child.clone();
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
        .map_err(|e| AppError::msg(format!("{} task failed: {e}", capitalise(noun))))?;

        let _ = progress_thread.join();
        let stderr_tail = stderr_thread.join().unwrap_or_default();

        if let Ok(mut guard) = self.child.lock() {
            *guard = None;
        }

        if self.take_cancelled() {
            return Err(AppError::msg(format!("The {noun} was cancelled.")));
        }

        match status {
            Some(s) if s.success() => Ok(()),
            Some(s) => Err(AppError::msg(format!(
                "ffmpeg exited with {s}.\n{stderr_tail}"
            ))),
            None => Err(AppError::msg(format!(
                "The {noun} stopped unexpectedly.\n{stderr_tail}"
            ))),
        }
    }
}

fn capitalise(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}
