//! Text file I/O plus the path conventions for a project's sidecar files.

use crate::error::{AppError, AppResult};
use encoding_rs::{UTF_16BE, UTF_16LE, WINDOWS_1252};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

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

// --- Overlay templates and their images ---------------------------------------

/// The folder templates are saved to and listed from, made on first use.
fn templates_folder(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::msg(format!("No app data directory: {e}")))?
        .join("templates");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[tauri::command]
pub fn templates_dir(app: AppHandle) -> AppResult<String> {
    Ok(templates_folder(&app)?.to_string_lossy().to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateFile {
    pub path: String,
    pub name: String,
    /// Milliseconds since the epoch.
    pub modified: u64,
}

/// Every `.sstoverlay` in the templates folder, newest first.
#[tauri::command]
pub fn list_templates(app: AppHandle) -> AppResult<Vec<TemplateFile>> {
    let dir = templates_folder(&app)?;
    let mut found: Vec<TemplateFile> = std::fs::read_dir(&dir)?
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("sstoverlay")))
        .map(|e| {
            let path = e.path();
            let modified = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as u64);
            TemplateFile {
                name: path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                path: path.to_string_lossy().to_string(),
                modified,
            }
        })
        .collect();
    found.sort_by_key(|f| std::cmp::Reverse(f.modified));
    Ok(found)
}

/// Undoes `encodeURIComponent`, so a header can carry any path.
fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Only PNGs, and only into a project's `… assets` folder: this writes bytes
/// the webview hands it, so it must not be able to write anything else.
fn writable_asset(path: &Path) -> bool {
    let png = path.extension().is_some_and(|x| x.eq_ignore_ascii_case("png"));
    let in_assets = path
        .parent()
        .and_then(|p| p.file_name())
        .is_some_and(|n| n.to_string_lossy().ends_with(" assets"));
    png && in_assets && path.is_absolute()
}

/// Writes one PNG — an image a template carried — into a project's assets
/// folder. The body is the raw bytes; the `x-path` header the percent-encoded
/// path. Returns false when an identical file was already there.
#[tauri::command]
pub fn write_asset_png(request: tauri::ipc::Request<'_>) -> AppResult<bool> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::msg("Expected the image as raw bytes."));
    };
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .and_then(percent_decode)
        .ok_or_else(|| AppError::msg("No file path for the image."))?;
    let path = PathBuf::from(path);
    if !writable_asset(&path) || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(AppError::msg(format!("Not a place for an image: {}", path.display())));
    }
    if std::fs::read(&path).is_ok_and(|old| old == *bytes) {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, bytes)
        .map_err(|e| AppError::msg(format!("Could not write {}: {e}", path.display())))?;
    Ok(true)
}

/// The bytes of an image file, for the webview to re-encode as a PNG inside
/// a template. Images only: it hands file contents to the page.
#[tauri::command]
pub fn read_image_file(path: String) -> AppResult<tauri::ipc::Response> {
    let p = Path::new(&path);
    let image = p.extension().is_some_and(|x| {
        ["png", "jpg", "jpeg", "webp", "bmp"].iter().any(|e| x.eq_ignore_ascii_case(e))
    });
    if !image {
        return Err(AppError::msg(format!("Not an image: {path}")));
    }
    let bytes = std::fs::read(p).map_err(|e| AppError::msg(format!("Could not read {path}: {e}")))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    #[test]
    fn decodes_a_percent_encoded_path() {
        assert_eq!(percent_decode("C%3A%5CFilm%20M%C3%BCller%5Ca.png").as_deref(), Some("C:\\Film Müller\\a.png"));
        assert_eq!(percent_decode("bad%2").as_deref(), None);
    }

    #[test]
    fn writes_images_only_into_an_assets_folder() {
        let root = std::env::temp_dir();
        assert!(writable_asset(&root.join("Film assets").join("img-abc.png")));
        assert!(!writable_asset(&root.join("Film assets").join("img-abc.exe")));
        assert!(!writable_asset(&root.join("Documents").join("img-abc.png")));
        assert!(!writable_asset(Path::new("Film assets/img-abc.png")));
    }

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
