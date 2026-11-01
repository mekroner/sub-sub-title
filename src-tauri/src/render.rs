//! Burn an .ass subtitle file into the video with ffmpeg, with the video's
//! own soundtrack or the Voiceover tab's mix in its place.

use crate::error::{AppError, AppResult};
use crate::edit::{build_graph_with, num, rate, work_dir as edit_work_dir, RenderPlan};
use crate::ffmpeg_job::FfmpegJob;
use std::fmt::Write as _;
use crate::media::{ffmpeg_bin, filter_script_args, quiet_command};
use crate::mixdown::{levelling, mix_to_file, MixdownRequest};
use serde::Serialize;
use std::path::{Path, PathBuf};
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

/// Mixes the voiceover to `mix`, whole, reporting progress as the "mixing"
/// phase; returns the gain that brings it to its loudness target, if any.
async fn mix_into(app: &AppHandle, job: &FfmpegJob, request: MixdownRequest, mix: &Path) -> AppResult<f64> {
    let _ = std::fs::remove_file(mix);
    let cancelled = job.cancelled.clone();
    let mix_path = mix.to_path_buf();
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
        Ok(gain) => Ok(gain),
        Err(e) => Err(if job.take_cancelled() {
            AppError::msg("The render was cancelled.")
        } else {
            e
        }),
    }
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
    let mix_gain_db = match audio {
        Some(request) => match mix_into(&app, &state.job, request, &mix).await {
            Ok(gain) => gain,
            Err(e) => {
                let _ = std::fs::remove_file(&mix);
                return Err(e);
            }
        },
        None => {
            let _ = std::fs::remove_file(&mix);
            0.0
        }
    };
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

// --- Teaser -------------------------------------------------------------------

/// The filter graph for a teaser: the video up to `at` with its subtitles and
/// sound, faded out over `fade`, then the post-teaser screen. The video is
/// input 0, the mix (when there is one) input 1, and the screen's inputs
/// follow. Pure, for the tests; returns the screen's input arguments too.
pub fn teaser_graph(
    at: f64,
    fade: f64,
    mix_gain_db: Option<f64>,
    has_audio: bool,
    post: &RenderPlan,
) -> AppResult<(Vec<String>, String)> {
    // Written to catch NaN as well as zero.
    if !at.is_finite() || at <= 0.0 {
        return Err(AppError::msg("The teaser cutoff must be after the start."));
    }
    let fps = rate(post.fps);
    let fade = fade.clamp(0.0, at);
    let mut graph = String::new();

    // Picture: burned-in subtitles, normalised to the canvas the screen uses,
    // so the two halves join.
    let _ = write!(
        graph,
        "[0:v]subtitles=teaser.ass,fps={fps},scale={}:{},setsar=1,format=yuv420p",
        post.width, post.height
    );
    if fade > 0.0 {
        let _ = write!(graph, ",fade=t=out:st={}:d={}", num(at - fade), num(fade));
    }
    let _ = writeln!(graph, ",setpts=PTS-STARTPTS[tv];");

    // Sound: the mix, the video's own, or silence; exactly `at` long.
    let source = match (mix_gain_db, has_audio) {
        (Some(gain), _) => format!("[1:a]volume={}dB,", num(gain)),
        (None, true) => "[0:a]".to_string(),
        (None, false) => "anullsrc=r=48000:cl=stereo,".to_string(),
    };
    let _ = write!(
        graph,
        "{source}aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=0:{at},apad=whole_dur={at}",
        at = num(at)
    );
    if fade > 0.0 {
        let _ = write!(graph, ",afade=t=out:st={}:d={}", num(at - fade), num(fade));
    }
    let _ = writeln!(graph, ",asetpts=PTS-STARTPTS[ta];");

    if post.total > 0.0 {
        let first = if mix_gain_db.is_some() { 2 } else { 1 };
        let (inputs, screen) = build_graph_with(post, first, "p_")?;
        graph.push_str(&screen);
        let _ = writeln!(graph, ";[tv][ta][p_vout][p_aout]concat=n=2:v=1:a=1[vout][aout]");
        Ok((inputs, graph))
    } else {
        let _ = writeln!(graph, "[tv]null[vout];[ta]anull[aout]");
        Ok((Vec::new(), graph))
    }
}

/// Renders a teaser: the video up to `at`, subtitles burned in and the
/// voiceover mix (or its own sound) as audio, faded out over `fade`, then the
/// post-teaser screen `post` over black, in silence. Its text and images are
/// staged in the bake's work dir first, as for a bake.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn render_teaser(
    app: AppHandle,
    state: tauri::State<'_, RenderState>,
    video_path: String,
    ass_path: String,
    output_path: String,
    at: f64,
    fade: f64,
    crf: Option<u32>,
    audio: Option<MixdownRequest>,
    has_audio: bool,
    post: RenderPlan,
) -> AppResult<()> {
    if Path::new(&output_path) == Path::new(&video_path) {
        return Err(AppError::msg(
            "The output file would overwrite the source video. Choose another name.",
        ));
    }
    let dir = edit_work_dir(&app)?;
    std::fs::copy(&ass_path, dir.join("teaser.ass"))
        .map_err(|e| AppError::msg(format!("Could not stage the subtitle file: {e}")))?;
    let crf = crf.unwrap_or(18).clamp(0, 51);
    state.job.reset();

    let mix = dir.join("teaser-mix.wav");
    let gain = match audio {
        Some(mut request) => {
            request.duration = at;
            match mix_into(&app, &state.job, request, &mix).await {
                Ok(gain) => Some(gain),
                Err(e) => {
                    let _ = std::fs::remove_file(&mix);
                    return Err(e);
                }
            }
        }
        None => None,
    };

    let cleanup = |dir: &Path| {
        let _ = std::fs::remove_file(dir.join("teaser-mix.wav"));
        let _ = std::fs::remove_file(dir.join("teaser.ass"));
        for layer in post.layers.iter().filter(|l| l.staged) {
            let _ = std::fs::remove_file(dir.join(&layer.path));
        }
    };
    let (post_inputs, graph) = match teaser_graph(at, fade, gain, has_audio, &post) {
        Ok(built) => built,
        Err(e) => {
            cleanup(&dir);
            return Err(e);
        }
    };
    std::fs::write(dir.join("teaser.txt"), &graph)
        .map_err(|e| AppError::msg(format!("Could not write the filter graph: {e}")))?;

    let mut command = quiet_command(&ffmpeg_bin());
    command
        .current_dir(&dir)
        .args(["-hide_banner", "-nostdin", "-y", "-t", &num(at), "-i"])
        .arg(&video_path);
    if gain.is_some() {
        command.args(["-i", "teaser-mix.wav"]);
    }
    command
        .args(&post_inputs)
        .args(filter_script_args("teaser.txt"))
        .args(["-map", "[vout]", "-map", "[aout]"])
        .args(["-c:v", "libx264", "-crf", &crf.to_string(), "-preset", "medium"])
        .args(["-pix_fmt", "yuv420p", "-r", &rate(post.fps)])
        .args(MIX_AUDIO)
        .args(["-movflags", "+faststart", "-nostats", "-progress", "pipe:1"])
        .arg(&output_path);

    let total = at + post.total.max(0.0);
    let progress_app = app.clone();
    let result = state
        .job
        .run(command, total, "render", move |p| {
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
    cleanup(&dir);
    if result.is_err() {
        let _ = std::fs::remove_file(&output_path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::{PlanLayer, PlanRect};

    fn screen(total: f64) -> RenderPlan {
        RenderPlan {
            width: 640,
            height: 360,
            fps: 25.0,
            total,
            layers: vec![PlanLayer {
                kind: "image".into(),
                path: "t-abc.png".into(),
                staged: true,
                start: 0.0,
                duration: total,
                offset: 0.0,
                fade_in: 0.0,
                fade_out: 0.0,
                opacity: 1.0,
                rects: vec![PlanRect { time: 0.0, x: 10.0, y: 20.0, w: 100.0, h: 50.0 }],
                audio: None,
            }],
        }
    }

    #[test]
    fn cuts_the_video_with_its_subtitles_and_mix_then_appends_the_screen() {
        let (inputs, graph) = teaser_graph(30.0, 0.5, Some(-2.0), true, &screen(4.0)).unwrap();
        assert!(graph.starts_with(
            "[0:v]subtitles=teaser.ass,fps=25,scale=640:360,setsar=1,format=yuv420p,fade=t=out:st=29.5:d=0.5,setpts=PTS-STARTPTS[tv];"
        ));
        assert!(graph.contains("[1:a]volume=-2dB,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=0:30,apad=whole_dur=30,afade=t=out:st=29.5:d=0.5,asetpts=PTS-STARTPTS[ta];"));
        // The screen's image is input 2, after the video and the mix.
        assert_eq!(inputs, ["-loop", "1", "-framerate", "25", "-t", "4", "-i", "t-abc.png"]);
        assert!(graph.contains("[2:v]setpts"));
        assert!(graph.contains("color=c=black:s=640x360:r=25:d=4,format=gbrp[p_b0];"));
        assert!(graph.contains("[tv][ta][p_vout][p_aout]concat=n=2:v=1:a=1[vout][aout]"));
    }

    #[test]
    fn uses_the_videos_own_sound_or_silence_and_can_cut_hard() {
        let (_, own) = teaser_graph(10.0, 0.0, None, true, &screen(2.0)).unwrap();
        assert!(own.contains("[0:a]aformat="));
        assert!(!own.contains("fade=t=out"));
        assert!(own.contains("[1:v]setpts"));
        let (_, silent) = teaser_graph(10.0, 0.0, None, false, &screen(2.0)).unwrap();
        assert!(silent.contains("anullsrc=r=48000:cl=stereo,aformat="));
        let (inputs, bare) = teaser_graph(10.0, 1.0, None, true, &screen(0.0)).unwrap();
        assert!(inputs.is_empty());
        assert!(bare.ends_with("[tv]null[vout];[ta]anull[aout]\n"));
        assert!(teaser_graph(0.0, 0.0, None, true, &screen(1.0)).is_err());
    }
}
