//! Voice templates: reference clips kept beside the app rather than a
//! project, so a voice built once — from a film, an interview, any recording —
//! can be given to a speaker in any project afterwards.
//!
//! Each template is a WAV in the templates folder plus an entry in its index.
//! A speaker using one references the template's file directly, so changing a
//! speaker from one template to another marks their lines as changed.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::engine::local_dir;
use crate::error::{AppError, AppResult};
use crate::tts::probe_seconds;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTemplate {
    pub id: String,
    pub name: String,
    /// The reference clip, inside the templates folder.
    pub file: String,
    /// The clip it was copied from, which a speaker may still reference:
    /// that speaker is using this template too.
    #[serde(default)]
    pub source: String,
    /// Its length in seconds; 0 when it could not be measured.
    pub seconds: f64,
    /// Milliseconds since the Unix epoch.
    pub created_at: u64,
}

fn templates_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = local_dir(app)?.join("voice-templates");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn index_path(dir: &Path) -> PathBuf {
    dir.join("templates.json")
}

/// A missing or unreadable index is an empty library.
fn read_index(dir: &Path) -> Vec<VoiceTemplate> {
    std::fs::read(index_path(dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_index(dir: &Path, templates: &[VoiceTemplate]) -> AppResult<()> {
    // Written beside and renamed over, so a crash mid-write cannot lose the list.
    let tmp = dir.join("templates.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(templates)?)?;
    std::fs::rename(&tmp, index_path(dir))?;
    Ok(())
}

fn clean_name(name: &str) -> AppResult<String> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err(AppError::msg("A voice template needs a name."));
    }
    Ok(name.chars().take(80).collect())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Templates newest first; entries whose file has gone are left out.
fn list_in(dir: &Path) -> Vec<VoiceTemplate> {
    let mut templates: Vec<VoiceTemplate> = read_index(dir)
        .into_iter()
        .filter(|t| Path::new(&t.file).is_file())
        .collect();
    templates.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    templates
}

fn save_in(dir: &Path, name: &str, source: &str) -> AppResult<VoiceTemplate> {
    let name = clean_name(name)?;
    if !Path::new(source).is_file() {
        return Err(AppError::msg(format!("The voice clip is missing: {source}")));
    }
    let mut templates = read_index(dir);
    let created_at = now_millis();
    // Unique even for two saved within the same millisecond.
    let mut n = 0;
    let id = loop {
        let id = format!("{created_at:x}{}", if n == 0 { String::new() } else { format!("-{n}") });
        if !templates.iter().any(|t| t.id == id) && !dir.join(format!("{id}.wav")).exists() {
            break id;
        }
        n += 1;
    };
    let file = dir.join(format!("{id}.wav"));
    std::fs::copy(source, &file)?;
    let file = file.to_string_lossy().into_owned();
    let template = VoiceTemplate {
        id,
        name,
        source: source.to_string(),
        seconds: probe_seconds(&file).unwrap_or(0.0),
        file,
        created_at,
    };
    templates.push(template.clone());
    write_index(dir, &templates)?;
    Ok(template)
}

fn rename_in(dir: &Path, id: &str, name: &str) -> AppResult<VoiceTemplate> {
    let name = clean_name(name)?;
    let mut templates = read_index(dir);
    let template = templates
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| AppError::msg("That voice template no longer exists."))?;
    template.name = name;
    let renamed = template.clone();
    write_index(dir, &templates)?;
    Ok(renamed)
}

/// Removes the entry; the file goes to the Recycle Bin, so a template deleted
/// by mistake can still be got back.
fn delete_in(dir: &Path, id: &str, trash: impl Fn(&Path) -> AppResult<()>) -> AppResult<()> {
    let mut templates = read_index(dir);
    let Some(at) = templates.iter().position(|t| t.id == id) else {
        return Ok(());
    };
    let removed = templates.remove(at);
    write_index(dir, &templates)?;
    let file = Path::new(&removed.file);
    if file.is_file() {
        trash(file)?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_voice_templates(app: AppHandle) -> AppResult<Vec<VoiceTemplate>> {
    Ok(list_in(&templates_dir(&app)?))
}

/// Keeps a copy of `source` — a reference clip — as a new template.
#[tauri::command]
pub fn save_voice_template(app: AppHandle, name: String, source: String) -> AppResult<VoiceTemplate> {
    save_in(&templates_dir(&app)?, &name, &source)
}

#[tauri::command]
pub fn rename_voice_template(app: AppHandle, id: String, name: String) -> AppResult<VoiceTemplate> {
    rename_in(&templates_dir(&app)?, &id, &name)
}

#[tauri::command]
pub fn delete_voice_template(app: AppHandle, id: String) -> AppResult<()> {
    delete_in(&templates_dir(&app)?, &id, |file| {
        trash::delete(file).map_err(|e| {
            AppError::msg(format!(
                "Could not move {} to the Recycle Bin: {e}",
                file.display()
            ))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sst-templates-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn saves_renames_lists_and_deletes() {
        let dir = scratch("cycle");
        let source = dir.join("built.wav");
        std::fs::write(&source, b"RIFF....").unwrap();

        let first = save_in(&dir, "  Ada   Lovelace ", &source.to_string_lossy()).unwrap();
        let second = save_in(&dir, "Narrator", &source.to_string_lossy()).unwrap();
        assert_eq!(first.name, "Ada Lovelace");
        assert_ne!(first.id, second.id);
        assert!(Path::new(&first.file).is_file());
        assert_ne!(first.file, source.to_string_lossy());
        assert_eq!(first.source, source.to_string_lossy());

        // Newest first.
        let ids: Vec<_> = list_in(&dir).into_iter().map(|t| t.id).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&first.id) && ids.contains(&second.id));

        assert_eq!(rename_in(&dir, &first.id, "Ada").unwrap().name, "Ada");
        assert!(rename_in(&dir, &first.id, "   ").is_err());

        let trashed = std::cell::RefCell::new(Vec::new());
        delete_in(&dir, &first.id, |f| {
            trashed.borrow_mut().push(f.to_path_buf());
            std::fs::remove_file(f)?;
            Ok(())
        })
        .unwrap();
        assert_eq!(trashed.borrow().len(), 1);
        let left = list_in(&dir);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, second.id);
        // Deleting what is already gone is not an error.
        delete_in(&dir, &first.id, |_| panic!("nothing to trash")).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn leaves_out_templates_whose_file_is_gone() {
        let dir = scratch("gone");
        let source = dir.join("built.wav");
        std::fs::write(&source, b"RIFF....").unwrap();
        let t = save_in(&dir, "Gone", &source.to_string_lossy()).unwrap();
        std::fs::remove_file(&t.file).unwrap();
        assert!(list_in(&dir).is_empty());
        assert!(save_in(&dir, "Missing", &dir.join("nope.wav").to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
