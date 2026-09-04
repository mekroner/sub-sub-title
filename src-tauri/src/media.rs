//! ffprobe/ffmpeg integration: media inspection and waveform peak extraction.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Build a Command that never flashes a console window on Windows.
pub fn quiet_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Allow overriding the binaries if they are not on PATH.
pub fn ffmpeg_bin() -> String {
    std::env::var("SUBSUBTITLE_FFMPEG").unwrap_or_else(|_| "ffmpeg".to_string())
}

pub fn ffprobe_bin() -> String {
    std::env::var("SUBSUBTITLE_FFPROBE").unwrap_or_else(|_| "ffprobe".to_string())
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub duration: f64,
    pub has_audio: bool,
    pub has_video: bool,
    pub width: u32,
    pub height: u32,
    /// Frames per second, used for the frame-nudge shortcuts.
    pub fps: f64,
    pub video_codec: String,
    pub audio_codec: String,
}

#[derive(Deserialize)]
struct ProbeOutput {
    format: Option<ProbeFormat>,
    streams: Option<Vec<ProbeStream>>,
}

#[derive(Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
}

#[derive(Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    r_frame_rate: Option<String>,
    duration: Option<String>,
}

/// Parse the "30000/1001" rational frame-rate notation ffprobe reports.
fn parse_rational(s: &str) -> Option<f64> {
    let (num, den) = s.split_once('/')?;
    let num: f64 = num.trim().parse().ok()?;
    let den: f64 = den.trim().parse().ok()?;
    if den == 0.0 || num == 0.0 {
        return None;
    }
    Some(num / den)
}

#[tauri::command]
pub fn probe_media(app: AppHandle, path: String) -> AppResult<MediaInfo> {
    if !Path::new(&path).is_file() {
        return Err(AppError::msg(format!("File not found: {path}")));
    }

    // The webview loads the video over the asset protocol, which serves only
    // files inside its scope. Grant this one file rather than globbing the whole
    // filesystem in tauri.conf.json.
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|e| AppError::msg(format!("Could not grant access to the video: {e}")))?;

    let out = quiet_command(&ffprobe_bin())
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(&path)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| {
            AppError::msg(format!(
                "Could not run ffprobe ({e}). Install ffmpeg or set SUBSUBTITLE_FFPROBE."
            ))
        })?;

    if !out.status.success() {
        return Err(AppError::msg(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }

    let probe: ProbeOutput = serde_json::from_slice(&out.stdout)?;
    let streams = probe.streams.unwrap_or_default();

    let video = streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video"));
    let audio = streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("audio"));

    // Prefer the container duration; fall back to the video stream's own.
    let duration = probe
        .format
        .and_then(|f| f.duration)
        .and_then(|d| d.parse::<f64>().ok())
        .or_else(|| {
            video
                .and_then(|v| v.duration.as_ref())
                .and_then(|d| d.parse::<f64>().ok())
        })
        .unwrap_or(0.0);

    Ok(MediaInfo {
        duration,
        has_audio: audio.is_some(),
        has_video: video.is_some(),
        width: video.and_then(|v| v.width).unwrap_or(0),
        height: video.and_then(|v| v.height).unwrap_or(0),
        fps: video
            .and_then(|v| v.r_frame_rate.as_deref())
            .and_then(parse_rational)
            .unwrap_or(25.0),
        video_codec: video.and_then(|v| v.codec_name.clone()).unwrap_or_default(),
        audio_codec: audio.and_then(|a| a.codec_name.clone()).unwrap_or_default(),
    })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Peaks {
    /// Signed peak per bucket, normalised to -1.0..1.0.
    pub peaks: Vec<f32>,
    pub duration: f64,
    /// Buckets per second of audio.
    pub points_per_second: u32,
}

/// The cache key covers file identity and extraction resolution, so a re-encoded
/// video at the same path does not silently reuse stale peaks.
fn cache_key(path: &Path, pps: u32) -> AppResult<String> {
    let meta = std::fs::metadata(path)?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    meta.len().hash(&mut hasher);
    mtime.hash(&mut hasher);
    pps.hash(&mut hasher);
    Ok(format!("{:016x}-{}.json", hasher.finish(), pps))
}

fn peaks_cache_path(app: &AppHandle, path: &Path, pps: u32) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::msg(format!("No cache directory: {e}")))?
        .join("peaks");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(cache_key(path, pps)?))
}

/// Decode the audio track to mono 8 kHz PCM and reduce it to one signed peak per
/// bucket. Done here rather than in the webview so an hour-long file does not
/// have to be decoded into memory by WebView2.
#[tauri::command]
pub fn compute_peaks(
    app: AppHandle,
    path: String,
    points_per_second: Option<u32>,
    refresh: Option<bool>,
) -> AppResult<Peaks> {
    const SAMPLE_RATE: u32 = 8000;
    let pps = points_per_second.unwrap_or(80).clamp(10, 400);
    let src = PathBuf::from(&path);

    if !src.is_file() {
        return Err(AppError::msg(format!("File not found: {path}")));
    }

    let cache_path = peaks_cache_path(&app, &src, pps)?;
    if !refresh.unwrap_or(false) {
        if let Ok(bytes) = std::fs::read(&cache_path) {
            if let Ok(cached) = serde_json::from_slice::<Peaks>(&bytes) {
                return Ok(cached);
            }
        }
    }

    let out = quiet_command(&ffmpeg_bin())
        .args(["-v", "error", "-i"])
        .arg(&src)
        .args([
            "-vn",
            "-ac",
            "1",
            "-ar",
            &SAMPLE_RATE.to_string(),
            "-f",
            "s16le",
            "-",
        ])
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
            "ffmpeg could not extract audio: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }

    let pcm = out.stdout;
    let sample_count = pcm.len() / 2;
    if sample_count == 0 {
        return Err(AppError::msg(
            "This file has no decodable audio track, so no waveform can be drawn.",
        ));
    }

    let bucket = (SAMPLE_RATE / pps).max(1) as usize;
    let mut peaks: Vec<f32> = Vec::with_capacity(sample_count / bucket + 1);

    for chunk in pcm.chunks(bucket * 2) {
        let mut extreme: i32 = 0;
        for frame in chunk.chunks_exact(2) {
            let sample = i16::from_le_bytes([frame[0], frame[1]]) as i32;
            if sample.abs() > extreme.abs() {
                extreme = sample;
            }
        }
        // Rounded to 3 decimals: at this array length the JSON payload size
        // matters more than the extra precision.
        let normalised = (extreme as f32 / i16::MAX as f32).clamp(-1.0, 1.0);
        peaks.push((normalised * 1000.0).round() / 1000.0);
    }

    let result = Peaks {
        duration: sample_count as f64 / SAMPLE_RATE as f64,
        peaks,
        points_per_second: pps,
    };

    // A failed cache write should not fail the extraction.
    if let Ok(json) = serde_json::to_vec(&result) {
        let _ = std::fs::write(&cache_path, json);
    }

    Ok(result)
}

/// Reports which external tools are usable, so the UI can degrade gracefully
/// instead of failing at the moment of use.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub ffmpeg: bool,
    pub ffprobe: bool,
    pub ffmpeg_version: String,
}

#[tauri::command]
pub fn check_tools() -> ToolStatus {
    let probe = |bin: &str| -> Option<String> {
        let out = quiet_command(bin)
            .arg("-version")
            .stdin(Stdio::null())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        Some(
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .to_string(),
        )
    };

    let ffmpeg = probe(&ffmpeg_bin());
    ToolStatus {
        ffprobe: probe(&ffprobe_bin()).is_some(),
        ffmpeg_version: ffmpeg.clone().unwrap_or_default(),
        ffmpeg: ffmpeg.is_some(),
    }
}
