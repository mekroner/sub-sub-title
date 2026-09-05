//! App settings (a JSON file) and the OpenRouter API key (Windows Credential
//! Manager, via the keyring crate).

use crate::error::{AppError, AppResult};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const KEYRING_SERVICE: &str = "sub-sub-title";
const KEYRING_USER: &str = "openrouter";

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// OpenRouter model id, e.g. "anthropic/claude-sonnet-4.5".
    pub model: String,
    pub temperature: f32,
    /// How many preceding cues are sent as context to the continue-feature.
    pub context_lines: u32,
    /// How many candidate lines to ask for.
    pub candidate_count: u32,
    /// Extra guidance appended to the system prompt (tone, era, language...).
    pub style_notes: String,
    /// Default .ass styling used for export and the preview overlay.
    pub font_name: String,
    pub font_size: u32,
    pub bold: bool,
    pub outline: f32,
    /// Hex colour of the outline drawn around the glyphs.
    pub outline_color: String,
    pub shadow: f32,
    /// Hex colour of the drop shadow.
    pub shadow_color: String,
    /// Waveform extraction resolution, in points per second.
    pub peaks_resolution: u32,
    /// Enforced silence between adjacent cues, in seconds.
    pub min_gap: f32,
    /// Readability limits flagged in the cue list.
    pub max_chars_per_line: u32,
    pub max_lines: u32,
    /// Whether the offline spellchecker runs at all.
    pub spellcheck: bool,
    /// "american" or "british". A string, so an unknown value degrades to the
    /// default rather than refusing to load the file.
    pub dialect: String,
    /// Whisper model size used by the transcribe dialog, e.g. "medium".
    pub whisper_model: String,
    /// Whisper language code, or empty for auto-detect.
    pub whisper_language: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            model: "anthropic/claude-sonnet-4.5".to_string(),
            temperature: 0.9,
            context_lines: 12,
            candidate_count: 3,
            style_notes: String::new(),
            font_name: "Arial".to_string(),
            font_size: 48,
            bold: false,
            outline: 2.0,
            outline_color: "#000000".to_string(),
            shadow: 0.0,
            shadow_color: "#000000".to_string(),
            peaks_resolution: 80,
            min_gap: 0.04,
            max_chars_per_line: 42,
            max_lines: 2,
            spellcheck: true,
            dialect: "american".to_string(),
            whisper_model: "medium".to_string(),
            whisper_language: String::new(),
        }
    }
}

fn settings_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::msg(format!("No config directory: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> AppResult<Settings> {
    let path = settings_path(&app)?;
    match std::fs::read(&path) {
        // A corrupt or partial settings file should not stop the app booting.
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
        Err(_) => Ok(Settings::default()),
    }
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> AppResult<()> {
    let path = settings_path(&app)?;
    std::fs::write(&path, serde_json::to_vec_pretty(&settings)?)?;
    Ok(())
}

fn keyring_entry() -> AppResult<Entry> {
    Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(AppError::from)
}

/// The key itself is never returned to the frontend — only whether one is set.
#[tauri::command]
pub fn has_api_key() -> bool {
    keyring_entry()
        .and_then(|e| e.get_password().map_err(AppError::from))
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false)
}

#[tauri::command]
pub fn set_api_key(key: String) -> AppResult<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AppError::msg("The API key is empty."));
    }
    keyring_entry()?.set_password(key)?;
    Ok(())
}

#[tauri::command]
pub fn clear_api_key() -> AppResult<()> {
    match keyring_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        // Clearing a key that was never stored is a success from the UI's view.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::from(e)),
    }
}

/// Used by the AI module; not exposed as a command.
pub fn read_api_key() -> AppResult<String> {
    let key = keyring_entry()?.get_password().map_err(|e| match e {
        keyring::Error::NoEntry => AppError::msg(
            "No OpenRouter API key saved. Add one in Settings before using the continue-feature.",
        ),
        other => AppError::from(other),
    })?;
    if key.trim().is_empty() {
        return Err(AppError::msg("The saved OpenRouter API key is empty."));
    }
    Ok(key)
}
