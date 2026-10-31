//! The Voiceover tab's mix, rendered to an audio file.
//!
//! ffmpeg decodes the video's soundtrack and streams it here as raw 48 kHz
//! stereo floats; clip files are decoded whole, since they are short. The mix
//! itself is done in Rust rather than in an ffmpeg filter graph, because the
//! gain curves would have to become enormous filter expressions — and because
//! the curve maths must be exactly the preview's. `Curve` mirrors
//! `src/lib/automation.ts`, and both are tested against the same fixtures.
//!
//! The mixed samples are piped to a second ffmpeg, which encodes whatever the
//! output file's extension asks for.

use crate::error::{AppError, AppResult};
use crate::media::{ffmpeg_bin, quiet_command};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const RATE: u32 = 48_000;
const CHANNELS: usize = 2;
/// Frames mixed at a time. Gains are evaluated at each block's edges and
/// interpolated across it: about 21 ms, finer than any fade anyone draws.
const BLOCK: usize = 1024;
/// Mirrors `MIN_DB` in `src/lib/voiceover.ts`: at or below it is silence.
const MIN_DB: f64 = -60.0;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Default)]
pub struct MixdownState {
    cancelled: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GainPoint {
    pub time: f64,
    pub db: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixTrack {
    pub id: String,
    pub kind: String,
    pub gain_db: f64,
    pub muted: bool,
    pub solo: bool,
    pub automation: Vec<GainPoint>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixClip {
    pub track_id: String,
    pub file: String,
    pub start: f64,
    pub offset: f64,
    pub duration: f64,
    pub gain_db: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixdownRequest {
    pub video_path: String,
    /// False when the video has no audio stream, which ffmpeg would refuse.
    pub include_original: bool,
    pub output_path: String,
    /// The video's length; the mix runs to this or the last clip's end.
    pub duration: f64,
    pub tracks: Vec<MixTrack>,
    pub clips: Vec<MixClip>,
    /// The original's automatic duck under the cues, as the preview plays it.
    pub duck: Vec<GainPoint>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MixdownResult {
    pub seconds: f64,
    /// Loudest sample before limiting, in dBFS.
    pub peak_db: f64,
    /// Samples that went past full scale and were clamped.
    pub clipped: u64,
}

#[derive(Clone, Serialize)]
pub struct MixdownProgress {
    pub fraction: f64,
}

/// A gain curve: PCHIP (Fritsch–Carlson) through points in dB. See
/// `src/lib/automation.ts` for why — this must agree with it to the sample.
pub struct Curve {
    xs: Vec<f64>,
    ys: Vec<f64>,
    ms: Vec<f64>,
}

impl Curve {
    pub fn new(points: &[GainPoint]) -> Self {
        let xs: Vec<f64> = points.iter().map(|p| p.time).collect();
        let ys: Vec<f64> = points.iter().map(|p| p.db).collect();
        let n = xs.len();
        let mut ms = vec![0.0; n];
        let mut h = Vec::with_capacity(n.saturating_sub(1));
        let mut delta = Vec::with_capacity(n.saturating_sub(1));
        for k in 0..n.saturating_sub(1) {
            h.push(xs[k + 1] - xs[k]);
            delta.push(if h[k] > 0.0 { (ys[k + 1] - ys[k]) / h[k] } else { 0.0 });
        }
        for k in 1..n.saturating_sub(1) {
            if delta[k - 1] * delta[k] <= 0.0 {
                continue;
            }
            let w1 = 2.0 * h[k] + h[k - 1];
            let w2 = h[k] + 2.0 * h[k - 1];
            ms[k] = (w1 + w2) / (w1 / delta[k - 1] + w2 / delta[k]);
        }
        Curve { xs, ys, ms }
    }

    pub fn db_at(&self, time: f64) -> f64 {
        let n = self.xs.len();
        if n == 0 {
            return 0.0;
        }
        if time <= self.xs[0] {
            return self.ys[0];
        }
        if time >= self.xs[n - 1] {
            return self.ys[n - 1];
        }
        let (mut lo, mut hi) = (0usize, n - 1);
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if self.xs[mid] <= time {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let h = self.xs[hi] - self.xs[lo];
        if h <= 0.0 {
            return self.ys[hi];
        }
        let t = (time - self.xs[lo]) / h;
        let t2 = t * t;
        let t3 = t2 * t;
        (2.0 * t3 - 3.0 * t2 + 1.0) * self.ys[lo]
            + (t3 - 2.0 * t2 + t) * h * self.ms[lo]
            + (-2.0 * t3 + 3.0 * t2) * self.ys[hi]
            + (t3 - t2) * h * self.ms[hi]
    }
}

fn db_to_gain(db: f64) -> f64 {
    if db <= MIN_DB {
        0.0
    } else {
        10f64.powf(db / 20.0)
    }
}

/// A track ready to mix: its static gain, its curves, and whether it is heard.
struct TrackMix {
    audible: bool,
    gain_db: f64,
    curves: Vec<Curve>,
}

impl TrackMix {
    fn gain_at(&self, time: f64) -> f64 {
        if !self.audible {
            return 0.0;
        }
        db_to_gain(self.gain_db + self.curves.iter().map(|c| c.db_at(time)).sum::<f64>())
    }
}

struct ClipMix {
    track: usize,
    samples: Arc<Vec<f32>>,
    start_frame: u64,
    offset_frame: u64,
    frames: u64,
    gain: f32,
}

#[tauri::command]
pub fn cancel_mixdown(state: tauri::State<'_, MixdownState>) {
    state.cancelled.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub async fn mixdown_voiceover(
    app: AppHandle,
    state: tauri::State<'_, MixdownState>,
    request: MixdownRequest,
) -> AppResult<MixdownResult> {
    let output = PathBuf::from(&request.output_path);
    if output == PathBuf::from(&request.video_path) {
        return Err(AppError::msg(
            "The output file would overwrite the source video. Choose another name.",
        ));
    }
    let codec = codec_args(&output)?;
    let cancelled = state.cancelled.clone();
    cancelled.store(false, Ordering::SeqCst);

    let result = tauri::async_runtime::spawn_blocking(move || {
        let progress = |fraction: f64| {
            let _ = app.emit("mixdown-progress", MixdownProgress { fraction });
        };
        mix(&request, codec, &cancelled, &progress)
    })
    .await
    .map_err(|e| AppError::msg(format!("The export task failed: {e}")))?;

    if result.is_err() {
        // A half-written file looks like a finished one; remove it.
        let _ = std::fs::remove_file(&output);
    }
    result
}

/// Encoder arguments for the output's extension.
fn codec_args(output: &Path) -> AppResult<&'static [&'static str]> {
    let ext = output
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    Ok(match ext.as_str() {
        "wav" => &["-c:a", "pcm_s24le"],
        "flac" => &["-c:a", "flac", "-sample_fmt", "s32"],
        "mp3" => &["-c:a", "libmp3lame", "-b:a", "320k"],
        "m4a" => &["-c:a", "aac", "-b:a", "256k"],
        _ => {
            return Err(AppError::msg(
                "Export to a .wav, .flac, .mp3 or .m4a file.",
            ))
        }
    })
}

fn mix(
    request: &MixdownRequest,
    codec: &[&str],
    cancelled: &AtomicBool,
    progress: &dyn Fn(f64),
) -> AppResult<MixdownResult> {
    // --- Tracks and clips -----------------------------------------------------
    let any_solo = request.tracks.iter().any(|t| t.solo);
    let mut track_index = HashMap::new();
    let mut tracks = Vec::new();
    let mut original = None;
    for track in &request.tracks {
        let mut curves = vec![Curve::new(&track.automation)];
        if track.kind == "original" {
            curves.push(Curve::new(&request.duck));
            original = Some(tracks.len());
        }
        track_index.insert(track.id.clone(), tracks.len());
        tracks.push(TrackMix {
            audible: if any_solo { track.solo } else { !track.muted },
            gain_db: track.gain_db,
            curves,
        });
    }

    let mut decoded: HashMap<&str, Arc<Vec<f32>>> = HashMap::new();
    let mut clips = Vec::new();
    for clip in &request.clips {
        let Some(&track) = track_index.get(&clip.track_id) else {
            continue;
        };
        // A silent track's clips are not worth decoding.
        if !tracks[track].audible || clip.duration <= 0.0 {
            continue;
        }
        if cancelled.load(Ordering::SeqCst) {
            return Err(AppError::msg("The export was cancelled."));
        }
        let samples = match decoded.get(clip.file.as_str()) {
            Some(samples) => samples.clone(),
            None => {
                let samples = Arc::new(decode_whole(&clip.file)?);
                decoded.insert(&clip.file, samples.clone());
                samples
            }
        };
        clips.push(ClipMix {
            track,
            samples,
            start_frame: seconds_to_frames(clip.start),
            offset_frame: seconds_to_frames(clip.offset),
            frames: seconds_to_frames(clip.duration),
            gain: db_to_gain(clip.gain_db) as f32,
        });
    }

    let end = clips
        .iter()
        .map(|c| c.start_frame + c.frames)
        .max()
        .unwrap_or(0)
        .max(seconds_to_frames(request.duration));
    if end == 0 {
        return Err(AppError::msg("There is nothing to export: the mix is empty."));
    }

    // --- Processes --------------------------------------------------------------
    let original_audible = original.is_some_and(|i| tracks[i].audible);
    let mut decoder = if request.include_original && original_audible {
        Some(spawn_decoder(&request.video_path)?)
    } else {
        None
    };
    let mut source = decoder.as_mut().and_then(|(child, _)| child.stdout.take());

    let mut encoder = quiet_command(&ffmpeg_bin())
        .args(["-hide_banner", "-nostdin", "-v", "error", "-y"])
        .args(["-f", "f32le", "-ar", &RATE.to_string(), "-ac", &CHANNELS.to_string()])
        .args(["-i", "-"])
        .args(codec)
        .arg(&request.output_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::msg(format!("Could not start ffmpeg: {e}")))?;
    let mut sink = encoder
        .stdin
        .take()
        .ok_or_else(|| AppError::msg("ffmpeg took no input stream."))?;
    let encoder_errors = drain(encoder.stderr.take());

    // --- Mixing -------------------------------------------------------------------
    let mut buffer = vec![0f32; BLOCK * CHANNELS];
    let mut bytes = vec![0u8; BLOCK * CHANNELS * 4];
    let mut peak = 0f32;
    let mut clipped = 0u64;
    let mut done = 0u64;
    let mut last_progress = Instant::now();
    let mut outcome: AppResult<()> = Ok(());

    while done < end {
        if cancelled.load(Ordering::SeqCst) {
            outcome = Err(AppError::msg("The export was cancelled."));
            break;
        }
        let frames = BLOCK.min((end - done) as usize);
        let t0 = done as f64 / RATE as f64;
        let t1 = (done + frames as u64) as f64 / RATE as f64;
        let ramp = |track: usize| {
            let a = tracks[track].gain_at(t0) as f32;
            let b = tracks[track].gain_at(t1) as f32;
            (a, (b - a) / frames as f32)
        };

        buffer[..frames * CHANNELS].fill(0.0);

        // The original, scaled by its gain ramp across the block.
        if let (Some(stream), Some(track)) = (source.as_mut(), original) {
            let got = read_frames(stream, &mut bytes[..frames * CHANNELS * 4])?;
            if got < frames {
                // Past the soundtrack's end: silence from here on.
                source = None;
            }
            let (gain, step) = ramp(track);
            for f in 0..got {
                let g = gain + step * f as f32;
                for c in 0..CHANNELS {
                    let i = (f * CHANNELS + c) * 4;
                    let s = f32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
                    buffer[f * CHANNELS + c] += s * g;
                }
            }
        }

        // Every clip that overlaps this block.
        let block_end = done + frames as u64;
        for clip in &clips {
            let clip_end = clip.start_frame + clip.frames;
            if clip_end <= done || clip.start_frame >= block_end {
                continue;
            }
            let (gain, step) = ramp(clip.track);
            let from = clip.start_frame.max(done);
            let to = clip_end.min(block_end);
            for frame in from..to {
                let src = (clip.offset_frame + frame - clip.start_frame) as usize * CHANNELS;
                if src + CHANNELS > clip.samples.len() {
                    break;
                }
                let f = (frame - done) as usize;
                let g = (gain + step * f as f32) * clip.gain;
                for c in 0..CHANNELS {
                    buffer[f * CHANNELS + c] += clip.samples[src + c] * g;
                }
            }
        }

        for (i, sample) in buffer[..frames * CHANNELS].iter_mut().enumerate() {
            let magnitude = sample.abs();
            peak = peak.max(magnitude);
            if magnitude > 1.0 {
                clipped += 1;
                *sample = sample.clamp(-1.0, 1.0);
            }
            bytes[i * 4..i * 4 + 4].copy_from_slice(&sample.to_le_bytes());
        }
        if let Err(e) = sink.write_all(&bytes[..frames * CHANNELS * 4]) {
            outcome = Err(AppError::msg(format!("ffmpeg stopped taking audio ({e}).")));
            break;
        }

        done += frames as u64;
        if last_progress.elapsed() >= PROGRESS_INTERVAL {
            last_progress = Instant::now();
            progress(done as f64 / end as f64);
        }
    }

    // --- Shutdown -----------------------------------------------------------------
    drop(source);
    if let Some((mut child, errors)) = decoder {
        // It may still be decoding a soundtrack longer than the mix.
        let _ = child.kill();
        let _ = child.wait();
        let _ = errors.join();
    }
    // Closing its input is what tells the encoder to finish the file.
    drop(sink);
    if outcome.is_err() {
        let _ = encoder.kill();
    }
    let status = encoder.wait()?;
    let encoder_tail = encoder_errors.join().unwrap_or_default();
    outcome?;
    if !status.success() {
        return Err(AppError::msg(format!(
            "ffmpeg could not write the file ({status}).\n{encoder_tail}"
        )));
    }

    progress(1.0);
    Ok(MixdownResult {
        seconds: end as f64 / RATE as f64,
        peak_db: if peak > 0.0 { 20.0 * (peak as f64).log10() } else { f64::NEG_INFINITY },
        clipped,
    })
}

fn seconds_to_frames(seconds: f64) -> u64 {
    (seconds.max(0.0) * RATE as f64).round() as u64
}

/// A short file, decoded whole to interleaved 48 kHz stereo.
fn decode_whole(path: &str) -> AppResult<Vec<f32>> {
    let out = quiet_command(&ffmpeg_bin())
        .args(["-hide_banner", "-nostdin", "-v", "error", "-i"])
        .arg(path)
        .args(["-vn", "-ac", &CHANNELS.to_string(), "-ar", &RATE.to_string()])
        .args(["-f", "f32le", "-"])
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| AppError::msg(format!("Could not run ffmpeg: {e}")))?;
    if !out.status.success() {
        return Err(AppError::msg(format!(
            "Could not decode {path}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(out
        .stdout
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect())
}

/// The video's soundtrack, streamed rather than held: it can be hours long.
fn spawn_decoder(
    video: &str,
) -> AppResult<(Child, std::thread::JoinHandle<String>)> {
    let mut child = quiet_command(&ffmpeg_bin())
        .args(["-hide_banner", "-nostdin", "-v", "error", "-i"])
        .arg(video)
        .args(["-vn", "-ac", &CHANNELS.to_string(), "-ar", &RATE.to_string()])
        .args(["-f", "f32le", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::msg(format!("Could not start ffmpeg: {e}")))?;
    let errors = drain(child.stderr.take());
    Ok((child, errors))
}

/// Reads whole frames until the buffer is full or the stream ends; returns
/// how many frames arrived.
fn read_frames(stream: &mut ChildStdout, buf: &mut [u8]) -> AppResult<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match stream.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(AppError::msg(format!("Reading the soundtrack failed: {e}"))),
        }
    }
    Ok(filled / (CHANNELS * 4))
}

/// Reads a stderr pipe to its end on another thread, so a chatty ffmpeg can
/// never fill the pipe and stall; keeps the last lines for the error message.
fn drain(stderr: Option<std::process::ChildStderr>) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
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
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Fixtures {
        cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        points: Vec<GainPoint>,
        samples: Vec<(f64, f64)>,
    }

    /// The preview (TypeScript) and this export must agree on every curve, or
    /// what is rendered is not what was heard.
    #[test]
    fn curve_matches_the_preview_fixtures() {
        let fixtures: Fixtures =
            serde_json::from_str(include_str!("../../src/lib/automation.fixtures.json"))
                .expect("fixtures parse");
        assert!(!fixtures.cases.is_empty());
        for case in fixtures.cases {
            let curve = Curve::new(&case.points);
            for (time, expected) in case.samples {
                let got = curve.db_at(time);
                assert!(
                    (got - expected).abs() < 1e-9,
                    "{}: at {time} expected {expected}, got {got}",
                    case.name
                );
            }
        }
    }

    #[test]
    fn treats_the_floor_as_silence() {
        assert_eq!(db_to_gain(-60.0), 0.0);
        assert!((db_to_gain(0.0) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn soloing_silences_everything_else() {
        let track = |solo: bool| TrackMix {
            audible: solo,
            gain_db: 0.0,
            curves: vec![Curve::new(&[])],
        };
        assert_eq!(track(false).gain_at(1.0), 0.0);
        assert_eq!(track(true).gain_at(1.0), 1.0);
    }

    fn ffmpeg_available() -> bool {
        quiet_command(&ffmpeg_bin())
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    fn generate(path: &Path, source: &str, seconds: f64) {
        let ok = quiet_command(&ffmpeg_bin())
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", source, "-t"])
            .arg(seconds.to_string())
            .arg(path)
            .status()
            .unwrap()
            .success();
        assert!(ok, "could not generate {source}");
    }

    fn rms(samples: &[f32]) -> f64 {
        (samples.iter().map(|s| (*s as f64).powi(2)).sum::<f64>() / samples.len() as f64).sqrt()
    }

    /// End to end through real ffmpeg: a tone as the "video", a second tone as
    /// a clip, ducking under a cue. Skipped where ffmpeg is not installed.
    #[test]
    fn mixes_ducks_and_places_clips() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not found; skipping");
            return;
        }
        let dir = std::env::temp_dir().join(format!("sst-mixdown-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let video = dir.join("bed.wav");
        let clip = dir.join("line.wav");
        let out = dir.join("mix.wav");
        generate(&video, "sine=frequency=220:sample_rate=48000", 6.0);
        generate(&clip, "sine=frequency=880:sample_rate=48000", 1.0);

        let track = |id: &str, kind: &str| MixTrack {
            id: id.into(),
            kind: kind.into(),
            gain_db: 0.0,
            muted: false,
            solo: false,
            automation: vec![],
        };
        let request = MixdownRequest {
            video_path: video.to_string_lossy().into(),
            include_original: true,
            output_path: out.to_string_lossy().into(),
            duration: 6.0,
            tracks: vec![track("original", "original"), track("vo", "voice")],
            clips: vec![MixClip {
                track_id: "vo".into(),
                file: clip.to_string_lossy().into(),
                start: 4.0,
                offset: 0.0,
                duration: 1.0,
                gain_db: 0.0,
            }],
            // Down 20 dB across 2..3 s, with sharp edges.
            duck: vec![
                GainPoint { time: 1.99, db: 0.0 },
                GainPoint { time: 2.0, db: -20.0 },
                GainPoint { time: 3.0, db: -20.0 },
                GainPoint { time: 3.01, db: 0.0 },
            ],
        };
        let result = mix(&request, codec_args(&out).unwrap(), &AtomicBool::new(false), &|_| {})
            .expect("mix succeeds");
        assert!((result.seconds - 6.0).abs() < 0.01);

        let mixed = decode_whole(&out.to_string_lossy()).unwrap();
        let window = |from: f64, to: f64| {
            &mixed[(from * RATE as f64) as usize * CHANNELS..(to * RATE as f64) as usize * CHANNELS]
        };
        let bed = rms(window(0.5, 1.5));
        let ducked = rms(window(2.2, 2.8));
        let with_clip = rms(window(4.2, 4.8));
        // ffmpeg's sine is at -18 dBFS-ish; what matters is the ratios.
        let duck_db = 20.0 * (ducked / bed).log10();
        assert!((duck_db + 20.0).abs() < 0.5, "duck was {duck_db} dB");
        assert!(with_clip > bed * 1.2, "the clip should add to the bed");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn picks_the_encoder_from_the_extension() {
        assert!(codec_args(Path::new("a.WAV")).is_ok());
        assert!(codec_args(Path::new("a.flac")).is_ok());
        assert!(codec_args(Path::new("a.mp4")).is_err());
    }
}
