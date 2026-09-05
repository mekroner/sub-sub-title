//! The user's personal word list: words the spellchecker should never flag,
//! in any project. Project-specific vocabulary (character names, invented
//! places) lives in the `.sstproj` instead.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

fn dictionary_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::msg(format!("No config directory: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("dictionary.json"))
}

/// A corrupt or missing word list is an empty one; it must never stop the app
/// from checking text.
#[tauri::command]
pub fn load_user_dictionary(app: AppHandle) -> AppResult<Vec<String>> {
    let path = dictionary_path(&app)?;
    match std::fs::read(&path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
        Err(_) => Ok(Vec::new()),
    }
}

#[tauri::command]
pub fn save_user_dictionary(app: AppHandle, words: Vec<String>) -> AppResult<()> {
    let path = dictionary_path(&app)?;
    let cleaned = normalize(words);
    std::fs::write(&path, serde_json::to_vec_pretty(&cleaned)?)?;
    Ok(())
}

/// Trimmed, non-empty, case-insensitively deduplicated, and sorted so the file
/// stays readable and diffable by hand.
fn normalize(words: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = words
        .into_iter()
        .map(|word| word.trim().to_string())
        .filter(|word| !word.is_empty() && seen.insert(word.to_lowercase()))
        .collect();
    out.sort_by_key(|word| word.to_lowercase());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_a_messy_list() {
        let out = normalize(vec![
            "  Kaelen ".into(),
            "kaelen".into(),
            "".into(),
            "   ".into(),
            "Arda".into(),
        ]);
        assert_eq!(out, vec!["Arda".to_string(), "Kaelen".to_string()]);
    }
}
