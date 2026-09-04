//! Text file I/O plus the path conventions for a project's sidecar files.

use crate::error::{AppError, AppResult};
use encoding_rs::{UTF_16BE, UTF_16LE, WINDOWS_1252};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// SRT files arrive from Subtitle Edit, Whisper, and the wider internet, so they
/// are frequently not UTF-8. Sniff the BOM, then fall back to Windows-1252 —
/// which never fails to decode and is the usual culprit for stray accented
/// characters in Latin-script subtitles.
fn decode_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return UTF_16LE.decode(&bytes[2..]).0.into_owned();
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return UTF_16BE.decode(&bytes[2..]).0.into_owned();
    }
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(body) {
        Ok(s) => s.to_string(),
        Err(_) => WINDOWS_1252.decode(body).0.into_owned(),
    }
}

#[tauri::command]
pub fn read_text_file(path: String) -> AppResult<String> {
    let bytes = std::fs::read(&path)
        .map_err(|e| AppError::msg(format!("Could not read {path}: {e}")))?;
    Ok(decode_text(&bytes))
}

/// Always writes UTF-8 without a BOM. ffmpeg's subtitle filter and every modern
/// player handle that; a BOM confuses some older SRT consumers.
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> AppResult<()> {
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    std::fs::write(&path, contents.as_bytes())
        .map_err(|e| AppError::msg(format!("Could not write {path}: {e}")))?;
    Ok(())
}

#[tauri::command]
pub fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

/// A video path passed on the command line, so the app can be wired up to
/// "Open with" in Explorer or launched from a shell.
#[tauri::command]
pub fn startup_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| !arg.starts_with('-') && Path::new(arg).is_file())
}

/// Every export and the sidecar are named after the video, so the frontend never
/// has to do platform-specific path surgery.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPaths {
    pub dir: String,
    pub stem: String,
    /// The `.sstproj` project file suggested by Save As.
    pub project: String,
    /// Legacy `.captions.json`, still read when opening a bare video.
    pub sidecar: String,
    pub srt: String,
    pub ass: String,
    pub burned: String,
}

#[tauri::command]
pub fn derive_paths(video_path: String) -> AppResult<ProjectPaths> {
    let p = PathBuf::from(&video_path);
    let dir = p
        .parent()
        .map(|d| d.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| AppError::msg(format!("Not a usable file path: {video_path}")))?;

    let join = |suffix: &str| dir.join(format!("{stem}{suffix}")).to_string_lossy().to_string();

    Ok(ProjectPaths {
        project: join(".sstproj"),
        sidecar: join(".captions.json"),
        srt: join(".srt"),
        ass: join(".ass"),
        burned: join(".subtitled.mp4"),
        dir: dir.to_string_lossy().to_string(),
        stem,
    })
}
