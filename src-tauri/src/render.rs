//! Burn an .ass subtitle file into the video with ffmpeg, with the video's
//! own soundtrack or the Voiceover tab's mix in its place.

use crate::error::{AppError, AppResult};
use crate::ffmpeg_job::FfmpegJob;
use crate::media::{ffmpeg_bin, quiet_command};
use crate::mixdown::{levelling, mix_to_file, MixdownRequest};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

/// Holds the running ffmpeg process so it can be cancelled mid-encode.
#[derive(Default)]
pub struct RenderState {
    job: FfmpegJob,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderProgress {
    /// "mixing" while the voiceover is mixed down, then "encoding".
    pub phase: &'static str,
    /// 0.0..1.0, or -1.0 when the total duration is unknown.
    pub fraction: f64,
    pub time_seconds: f64,
    pub speed: String,
}

/// The voiceover mix the video gets in place of its own soundtrack, encoded
/// once for the video: AAC at a bitrate that leaves dialogue intact.
const MIX_AUDIO: [&str; 4] = ["-c:a", "aac", "-b:a", "192k"];

#[tauri::command]
pub fn cancel_render(state: tauri::State<'_, RenderState>) -> AppResult<()> {
    state.job.cancel("render")
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

// A Tauri command's arguments are what the frontend names in its call;
// bundling them into a struct would only move the list there.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn render_burn_in(
    app: AppHandle,
    state: tauri::State<'_, RenderState>,
    video_path: String,
    ass_path: String,
    output_path: String,
    duration: f64,
    crf: Option<u32>,
    audio: Option<MixdownRequest>,
) -> AppResult<()> {
    if PathBuf::from(&output_path) == PathBuf::from(&video_path) {
        return Err(AppError::msg(
            "The output file would overwrite the source video. Choose another name.",
        ));
    }

    let work_dir = stage_subtitles(&app, &ass_path)?;
    let crf = crf.unwrap_or(18).clamp(0, 51);
    state.job.reset();

    // The mix is rendered first, whole, so the encode below reads it like any
    // other input. It is removed whatever happens.
    let mix = work_dir.join("mix.wav");
    let _ = std::fs::remove_file(&mix);
    // The gain that brings the mix to its loudness target, if it has one.
    let mut mix_gain_db = 0.0;
    if let Some(request) = audio {
        let cancelled = state.job.cancelled.clone();
        let mix_path = mix.clone();
        let mix_app = app.clone();
        let mixed = tauri::async_runtime::spawn_blocking(move || {
            let progress = |fraction: f64| {
                let _ = mix_app.emit(
                    "render-progress",
                    RenderProgress {
                        phase: "mixing",
                        fraction,
                        time_seconds: fraction * request.duration,
                        speed: String::new(),
                    },
                );
            };
            let result = mix_to_file(&request, &mix_path, &cancelled, &progress)?;
            Ok(request
                .target_lufs
                .and_then(|target| levelling(&mix_path, result.seconds, target))
                .map_or(0.0, |l| l.gain_db))
        })
        .await
        .map_err(|e| AppError::msg(format!("Mixing the voiceover failed: {e}")));
        match mixed.and_then(|r: AppResult<f64>| r) {
            Ok(gain) => mix_gain_db = gain,
            Err(e) => {
                let _ = std::fs::remove_file(&mix);
                return Err(if state.job.take_cancelled() {
                    AppError::msg("The render was cancelled.")
                } else {
                    e
                });
            }
        }
    }
    let with_mix = mix.is_file();

    let mut command = quiet_command(&ffmpeg_bin());
    command
        .current_dir(&work_dir)
        .args(["-hide_banner", "-nostdin", "-y", "-i"])
        .arg(&video_path);
    if with_mix {
        // Relative, like the subtitles: the work dir is the current dir.
        command.args(["-i", "mix.wav", "-map", "0:v:0", "-map", "1:a:0"]);
    }
    command
        // Relative name only; see stage_subtitles above.
        .args(["-vf", "subtitles=subs.ass"])
        .args([
            "-c:v", "libx264", "-crf", &crf.to_string(), "-preset", "medium",
        ]);
    if with_mix {
        // The mix runs to the last clip, which may end after the picture.
        command
            .args(["-af", &format!("volume={mix_gain_db:.2}dB")])
            .args(MIX_AUDIO)
            .arg("-shortest");
    } else {
        command.args(["-c:a", "copy"]);
    }
    command
        .args(["-movflags", "+faststart"])
        .args(["-nostats", "-progress", "pipe:1"])
        .arg(&output_path);
    let progress_app = app.clone();
    let result = state
        .job
        .run(command, duration, "render", move |p| {
            let _ = progress_app.emit(
                "render-progress",
                RenderProgress {
                    phase: "encoding",
                    fraction: p.fraction,
                    time_seconds: p.time_seconds,
                    speed: p.speed,
                },
            );
        })
        .await;
    let _ = std::fs::remove_file(&mix);
    result
}
