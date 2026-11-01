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

/// Whether ffmpeg has the Rubber Band time-stretcher, which speeds up speech
/// far more cleanly than `atempo`. Not every build includes it. Asked once a
/// run: a build's filters do not change while the app is open.
pub fn has_rubberband() -> bool {
    static RUBBERBAND: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *RUBBERBAND.get_or_init(|| {
        quiet_command(&ffmpeg_bin())
            .args(["-hide_banner", "-filters"])
            .stdin(Stdio::null())
            .output()
            .map(|out| {
                // Lines read " .. rubberband        A->A       Apply …".
                String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .any(|line| line.split_whitespace().nth(1) == Some("rubberband"))
            })
            .unwrap_or(false)
    })
}

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

/// How to hand ffmpeg a filter graph kept in a file. ffmpeg 7 added
/// `-/filter_complex <file>` and ffmpeg 8 removed `-filter_complex_script`,
/// which is all ffmpeg 6 and older understand; so ask which this one is.
pub fn filter_script_args(file: &str) -> [String; 2] {
    static MODERN: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    let modern = *MODERN.get_or_init(|| {
        quiet_command(&ffmpeg_bin())
            .args(["-hide_banner", "-version"])
            .stdin(Stdio::null())
            .output()
            .ok()
            .map(|out| String::from_utf8_lossy(&out.stdout).to_string())
            .is_none_or(|text| loads_options_from_files(&text))
    });
    let option = if modern { "-/filter_complex" } else { "-filter_complex_script" };
    [option.to_string(), file.to_string()]
}

/// True when `ffmpeg -version` says 7 or later, where `-/option file` works.
/// Builds that do not say a release — git snapshots, dated builds — are
/// recent, so they count as new; so does anything unreadable.
fn loads_options_from_files(version_output: &str) -> bool {
    let Some(rest) = version_output
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("ffmpeg version "))
    else {
        return true;
    };
    let rest = rest.strip_prefix('n').unwrap_or(rest);
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    match digits.parse::<u32>() {
        // A year: a dated snapshot.
        Ok(n) if n >= 2000 => true,
        Ok(major) => major >= 7,
        // "N-118000-g…": a build from the development branch.
        Err(_) => true,
    }
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
    /// Degrees clockwise the picture is shown at. Width and height are the
    /// displayed size, so they are already swapped for 90 and 270.
    pub rotation: i32,
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
    tags: Option<ProbeTags>,
    side_data_list: Option<Vec<ProbeSideData>>,
}

#[derive(Deserialize)]
struct ProbeTags {
    rotate: Option<String>,
}

#[derive(Deserialize)]
struct ProbeSideData {
    rotation: Option<f64>,
}

/// Clockwise display rotation, normalised to 0, 90, 180 or 270. The display
/// matrix states it counter-clockwise; the older `rotate` tag clockwise.
fn stream_rotation(stream: &ProbeStream) -> i32 {
    let from_matrix = stream
        .side_data_list
        .iter()
        .flatten()
        .find_map(|d| d.rotation)
        .map(|r| -r);
    let from_tag = stream
        .tags
        .as_ref()
        .and_then(|t| t.rotate.as_deref())
        .and_then(|r| r.trim().parse::<f64>().ok());
    let degrees = from_matrix.or(from_tag).unwrap_or(0.0);
    let quarter = ((degrees / 90.0).round() as i32).rem_euclid(4);
    quarter * 90
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

    let rotation = video.map(stream_rotation).unwrap_or(0);
    let (mut width, mut height) = (
        video.and_then(|v| v.width).unwrap_or(0),
        video.and_then(|v| v.height).unwrap_or(0),
    );
    if rotation % 180 != 0 {
        std::mem::swap(&mut width, &mut height);
    }

    Ok(MediaInfo {
        duration,
        has_audio: audio.is_some(),
        has_video: video.is_some(),
        width,
        height,
        rotation,
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

// --- Loudness -----------------------------------------------------------------

/// A stretch of audio's loudness, as ffmpeg's EBU R128 meter reports it.
#[derive(Debug, Clone, Copy)]
pub struct Loudness {
    /// Integrated loudness, LUFS.
    pub integrated: f64,
    /// True peak, dBTP.
    pub true_peak: f64,
}

impl Loudness {
    /// The gain, in dB, that brings this to `target` LUFS without the true
    /// peak passing `ceiling`. Silence, or a stretch too short to measure, is
    /// left as it is.
    pub fn gain_to(self, target: f64, ceiling: f64) -> f64 {
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
pub fn measure_loudness(path: &str, start: f64, end: f64) -> Option<Loudness> {
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

    #[test]
    fn reads_rotation_from_the_display_matrix_or_the_tag() {
        let stream = |json: &str| serde_json::from_str::<ProbeStream>(json).unwrap();
        assert_eq!(stream_rotation(&stream(r#"{"side_data_list":[{"rotation":-90}]}"#)), 90);
        assert_eq!(stream_rotation(&stream(r#"{"side_data_list":[{"rotation":90}]}"#)), 270);
        assert_eq!(stream_rotation(&stream(r#"{"tags":{"rotate":"180"}}"#)), 180);
        assert_eq!(stream_rotation(&stream(r#"{"side_data_list":[{}]}"#)), 0);
    }

    #[test]
    fn knows_which_ffmpeg_reads_a_filter_graph_from_a_file_how() {
        let says = |v: &str| loads_options_from_files(&format!("ffmpeg version {v} Copyright (c) 2000-2025\nbuilt with gcc"));
        assert!(!says("6.1.1-3ubuntu5"));
        assert!(!says("4.4.2-0ubuntu0.22.04.1"));
        assert!(!says("n6.0"));
        assert!(says("7.0.2-static https://johnvansickle.com/ffmpeg/"));
        assert!(says("8.0-full_build-www.gyan.dev"));
        assert!(says("n7.1"));
        assert!(says("N-118000-g1234abcd"));
        assert!(says("2025-10-01-git-abc1234-full_build-www.gyan.dev"));
        assert!(loads_options_from_files(""));
    }

    #[test]
    fn reads_loudnorm_output() {
        let stderr = "[Parsed_loudnorm_0 @ 0x1] \n{\n\t\"input_i\" : \"-31.52\",\n\t\"input_tp\" : \"-12.03\",\n\t\"input_lra\" : \"1.20\"\n}\n";
        let m = parse_loudnorm(stderr).expect("parses");
        assert_eq!(m.integrated, -31.52);
        assert_eq!(m.true_peak, -12.03);
        assert!(parse_loudnorm("no json here").is_none());
    }
}
