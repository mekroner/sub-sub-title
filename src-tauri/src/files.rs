//! Text file I/O plus the path conventions for a project's sidecar files.

use crate::error::{AppError, AppResult};
use encoding_rs::{UTF_16BE, UTF_16LE, WINDOWS_1252};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// SRT files arrive from Subtitle Edit, Whisper, and the wider internet, so they
/// are frequently not UTF-8. Sniff the BOM, then fall back to Windows-1252 —
/// which never fails to decode and is the usual culprit for stray accented
/// characters in Latin-script subtitles.
pub(crate) fn decode_text(bytes: &[u8]) -> String {
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

// --- Voice files ---------------------------------------------------------------

/// A file in a project's voiceover folder that nothing uses any more.
#[derive(Debug, Serialize)]
pub struct UnusedFile {
    pub path: String,
    pub bytes: u64,
}

/// Only a project's own voiceover folder is ever cleaned: the one named
/// `<video>.voiceover` beside the video, where takes and references go.
fn voiceover_folder(dir: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(dir);
    let named = path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.ends_with(".voiceover"));
    if named {
        Ok(path)
    } else {
        Err(AppError::msg(format!("Not a voiceover folder: {dir}")))
    }
}

/// A path as the filesystem compares it: on Windows either slash, any case.
fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) {
        text.replace('/', "\\").to_lowercase()
    } else {
        text.into_owned()
    }
}

fn is_wav(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("wav"))
}

/// The `.wav` files in the voiceover folder `dir` that are not in `keep`.
/// A folder that does not exist yet has none.
#[tauri::command]
pub fn voiceover_unused_files(dir: String, keep: Vec<String>) -> AppResult<Vec<UnusedFile>> {
    let folder = voiceover_folder(&dir)?;
    if !folder.is_dir() {
        return Ok(Vec::new());
    }
    let kept: HashSet<String> = keep.iter().map(|k| path_key(Path::new(k))).collect();
    let mut unused = Vec::new();
    for entry in std::fs::read_dir(&folder)? {
        let entry = entry?;
        let path = entry.path();
        if !entry.file_type()?.is_file() || !is_wav(&path) || kept.contains(&path_key(&path)) {
            continue;
        }
        unused.push(UnusedFile {
            path: path.to_string_lossy().into_owned(),
            bytes: entry.metadata()?.len(),
        });
    }
    unused.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(unused)
}

/// Moves voice files to the Recycle Bin, so a clean-up can be undone from
/// there. Every one must be a `.wav` directly inside the voiceover folder
/// `dir`; otherwise nothing is touched. Returns the bytes freed.
#[tauri::command]
pub fn voiceover_trash_files(dir: String, files: Vec<String>) -> AppResult<u64> {
    let folder = path_key(&voiceover_folder(&dir)?);
    let mut doomed = Vec::new();
    let mut bytes = 0;
    for file in &files {
        let path = PathBuf::from(file);
        let inside = path.parent().is_some_and(|p| path_key(p) == folder);
        if !inside || !is_wav(&path) {
            return Err(AppError::msg(format!("Not a voice file of this project: {file}")));
        }
        // Already gone is as good as cleaned.
        if let Ok(meta) = std::fs::metadata(&path) {
            bytes += meta.len();
            doomed.push(path);
        }
    }
    if !doomed.is_empty() {
        trash::delete_all(&doomed).map_err(|e| {
            AppError::msg(format!("Could not move the files to the Recycle Bin: {e}"))
        })?;
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_only_unused_wavs_in_a_voiceover_folder() {
        let root = std::env::temp_dir().join(format!("sst-unused-{}", std::process::id()));
        let folder = root.join("film.voiceover");
        std::fs::create_dir_all(folder.join("nested")).unwrap();
        for name in ["kept.wav", "Gone.WAV", "notes.txt", "nested/deep.wav"] {
            std::fs::write(folder.join(name), b"RIFF").unwrap();
        }
        let dir = folder.to_string_lossy().into_owned();
        // Kept by a path spelled differently from the listing's.
        let kept = folder.join("kept.wav").to_string_lossy().replace('\\', "/");
        let kept = if cfg!(windows) { kept.to_uppercase() } else { kept };

        let unused = voiceover_unused_files(dir.clone(), vec![kept]).unwrap();
        let names: Vec<_> = unused
            .iter()
            .map(|f| Path::new(&f.path).file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["Gone.WAV"]);
        assert_eq!(unused[0].bytes, 4);

        // Nothing outside such a folder, and nothing that is not a voice file.
        assert!(voiceover_unused_files(root.to_string_lossy().into_owned(), vec![]).is_err());
        let stray = root.join("other.wav").to_string_lossy().into_owned();
        assert!(voiceover_trash_files(dir.clone(), vec![stray]).is_err());
        let text = folder.join("notes.txt").to_string_lossy().into_owned();
        assert!(voiceover_trash_files(dir.clone(), vec![text]).is_err());
        let deep = folder.join("nested").join("deep.wav").to_string_lossy().into_owned();
        assert!(voiceover_trash_files(dir, vec![deep]).is_err());
        assert!(folder.join("notes.txt").is_file() && folder.join("nested/deep.wav").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }
}
