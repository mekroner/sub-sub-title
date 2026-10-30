//! A look at the video for a `/continue` run: one frame, grabbed with ffmpeg
//! and described in words by a vision model.
//!
//! The frame never leaves this side except to OpenRouter; the run only ever
//! sees the description. Shares the chat's cancel so Stop ends a look too.

use std::path::Path;
use std::process::Stdio;

use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use tauri::State;

use crate::ai::chat_completion_raw;
use crate::chat::{ChatState, CANCELLED};
use crate::error::{AppError, AppResult};
use crate::media::{ffmpeg_bin, quiet_command};
use crate::settings::read_api_key;

/// Wide enough to make out faces and objects, small enough to stay cheap.
const MAX_WIDTH: u32 = 768;
/// Room for the description, and for a reasoning model to think first: its
/// thinking counts against the same budget, and 600 was not always enough.
const MAX_TOKENS: u32 = 2_000;
/// Low: the same frame should read the same way twice.
const TEMPERATURE: f32 = 0.2;

const VISION_PROMPT: &str = "This is one frame from a video. Describe what is visible, objectively, in 60–150 words:
- the setting, and the time of day if it shows;
- how many people are visible, and for each their apparent age, expression, posture and what they are doing;
- the framing (close-up, medium, wide) and who or what is in focus;
- lighting and mood;
- notable objects, and any text you can read.

Rules: never guess who anyone is or give names. Where something cannot be made out, say it is unclear rather than guessing. Describe only what is in the frame; do not guess at the story.";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameRequest {
    pub video_path: String,
    /// Seconds into the video.
    pub time: f64,
    pub model: String,
    /// Something the run wants to know about the frame in particular.
    #[serde(default)]
    pub question: Option<String>,
}

/// ffmpeg's arguments for one JPEG frame at `time`, written to stdout.
fn frame_args(path: &Path, time: f64) -> Vec<String> {
    vec![
        "-v".into(),
        "error".into(),
        // Before the input: a fast seek to the nearest keyframe, then decoded
        // forward to the exact time.
        "-ss".into(),
        format!("{time:.3}"),
        "-i".into(),
        path.to_string_lossy().into_owned(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        format!("scale='min({MAX_WIDTH},iw)':-2"),
        "-f".into(),
        "image2pipe".into(),
        "-c:v".into(),
        "mjpeg".into(),
        "-q:v".into(),
        "4".into(),
        "-".into(),
    ]
}

fn grab_frame(path: &Path, time: f64) -> AppResult<Vec<u8>> {
    let out = quiet_command(&ffmpeg_bin())
        .args(frame_args(path, time))
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| {
            AppError::msg(format!(
                "Could not run ffmpeg ({e}). Install ffmpeg or set SUBSUBTITLE_FFMPEG."
            ))
        })?;
    if !out.status.success() {
        return Err(AppError::msg(format!(
            "ffmpeg could not grab the frame: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    if out.stdout.is_empty() {
        return Err(AppError::msg(format!("There is no frame at {time:.2} s.")));
    }
    Ok(out.stdout)
}

/// What the vision model is asked, with the run's own question if it has one.
fn prompt(question: Option<&str>) -> String {
    match question.map(str::trim).filter(|q| !q.is_empty()) {
        Some(q) => format!("{VISION_PROMPT}\n\nAlso answer, if the frame shows it: {q}"),
        None => VISION_PROMPT.to_string(),
    }
}

#[tauri::command]
pub async fn ai_describe_frame(
    state: State<'_, ChatState>,
    request: FrameRequest,
) -> AppResult<String> {
    if request.model.trim().is_empty() {
        return Err(AppError::msg("No vision model selected. Choose one under Chat in Settings."));
    }
    if !request.time.is_finite() || request.time < 0.0 {
        return Err(AppError::msg("The frame time must be a positive number of seconds."));
    }
    let path = Path::new(&request.video_path).to_path_buf();
    if !path.is_file() {
        return Err(AppError::msg(format!("Video not found: {}", request.video_path)));
    }
    let key = read_api_key()?;

    let task = tauri::async_runtime::spawn(async move {
        let time = request.time;
        let jpeg = tauri::async_runtime::spawn_blocking(move || grab_frame(&path, time))
            .await
            .map_err(AppError::from)??;
        let url = format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(jpeg)
        );
        let messages = [json!({
            "role": "user",
            "content": [
                { "type": "text", "text": prompt(request.question.as_deref()) },
                { "type": "image_url", "image_url": { "url": url } },
            ],
        })];
        // An empty reply comes back as an error saying why: out of tokens,
        // filtered, refused.
        chat_completion_raw(&key, &request.model, &messages, TEMPERATURE, MAX_TOKENS).await
    });

    let abort = task.inner().abort_handle();
    state.replace(Some(Box::new(move || abort.abort())));

    match task.await {
        Ok(result) => result,
        Err(tauri::Error::JoinError(e)) if e.is_cancelled() => Err(AppError::msg(CANCELLED)),
        Err(e) => Err(AppError::from(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_frame_is_sought_before_decoding_and_scaled_down() {
        let args = frame_args(Path::new("C:/v/clip.mp4"), 83.4);
        let at = |flag: &str| args.iter().position(|a| a == flag).unwrap();
        assert!(at("-ss") < at("-i"));
        assert_eq!(args[at("-ss") + 1], "83.400");
        assert_eq!(args[at("-i") + 1], "C:/v/clip.mp4");
        assert_eq!(args[at("-vf") + 1], "scale='min(768,iw)':-2");
        assert_eq!(args.last().unwrap(), "-");
    }

    #[test]
    fn the_runs_question_is_added_to_the_prompt() {
        assert_eq!(prompt(None), VISION_PROMPT);
        assert_eq!(prompt(Some("  ")), VISION_PROMPT);
        assert!(prompt(Some("What is she holding?")).ends_with("What is she holding?"));
    }
}
