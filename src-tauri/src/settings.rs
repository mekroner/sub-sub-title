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
    /// The user's own instructions, added to Fill's built-in writing guidance.
    /// Aliased so the style notes of the old continue-feature carry over.
    #[serde(alias = "styleNotes")]
    pub fill_instructions: String,
    /// Replaces Fill's built-in writing guidance when non-empty. The transcript
    /// conventions and reply format are always appended, so replies still parse.
    pub fill_guidance_override: String,
    /// Dialogue lines Fill shows the model before and after the slots.
    pub fill_lines_before: u32,
    pub fill_lines_after: u32,
    /// How many alternative takes Fill asks for.
    pub fill_takes: u32,
    /// "close", "open" or "wild". A string, like `dialect`, so an unknown value
    /// degrades to the default instead of failing the load.
    pub fill_latitude: String,
    /// Grey autocomplete while typing in a cue.
    pub ghost_enabled: bool,
    /// OpenRouter model id for autocomplete. Separate from `model` because it
    /// runs on every typing pause, so it should be small, fast and cheap.
    pub ghost_model: String,
    /// Typing pause, in milliseconds, before a suggestion is requested.
    pub ghost_delay_ms: u32,
    /// Dialogue lines autocomplete shows the model before and after the cue.
    pub ghost_lines_before: u32,
    pub ghost_lines_after: u32,
    /// Dialogue lines the chat panel's "Last N lines" button attaches.
    pub chat_lines_before: u32,
    /// OpenRouter model ids the chat panel offers. The first is the fallback.
    pub chat_models: Vec<String>,
    /// The chat panel's current pick. One no longer in `chat_models` falls
    /// back to the first entry.
    pub chat_model: String,
    /// "", "low", "medium" or "high"; "" leaves reasoning to the model.
    pub chat_effort: String,
    /// OpenRouter model that describes frames for `/continue`. "" leaves the
    /// run without eyes.
    pub vision_model: String,
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
    /// Wrap each exported .srt cue in its speaker's `<font color=...>`.
    pub srt_speaker_colors: bool,
    /// Waveform extraction resolution, in points per second.
    pub peaks_resolution: u32,
    /// Enforced silence between adjacent cues, in seconds.
    pub min_gap: f32,
    /// Readability limits flagged in the cue list.
    pub max_chars_per_line: u32,
    pub max_lines: u32,
    /// Reading speed, in characters per second, that the fit-timing command aims for.
    pub target_cps: f32,
    /// Whether the offline spellchecker runs at all.
    pub spellcheck: bool,
    /// "american" or "british". A string, so an unknown value degrades to the
    /// default rather than refusing to load the file.
    pub dialect: String,
    /// Whisper model size used by the transcribe dialog, e.g. "medium".
    pub whisper_model: String,
    /// Absolute path to a manually installed faster-whisper-xxl.exe. Empty means
    /// use the copy the app downloads and manages itself.
    pub whisper_engine_path: String,
    /// Whisper language code, or empty for auto-detect.
    pub whisper_language: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            model: "anthropic/claude-sonnet-4.5".to_string(),
            temperature: 0.9,
            fill_instructions: String::new(),
            fill_guidance_override: String::new(),
            fill_lines_before: 24,
            fill_lines_after: 4,
            fill_takes: 3,
            fill_latitude: "open".to_string(),
            ghost_enabled: true,
            ghost_model: "google/gemini-2.5-flash-lite".to_string(),
            ghost_delay_ms: 350,
            ghost_lines_before: 10,
            ghost_lines_after: 2,
            chat_lines_before: 10,
            chat_models: vec!["anthropic/claude-sonnet-4.5".to_string()],
            chat_model: String::new(),
            chat_effort: String::new(),
            vision_model: String::new(),
            font_name: "Arial".to_string(),
            font_size: 48,
            bold: false,
            outline: 2.0,
            outline_color: "#000000".to_string(),
            shadow: 0.0,
            shadow_color: "#000000".to_string(),
            srt_speaker_colors: true,
            peaks_resolution: 80,
            min_gap: 0.04,
            max_chars_per_line: 42,
            max_lines: 2,
            target_cps: 17.0,
            spellcheck: true,
            dialect: "american".to_string(),
            whisper_model: "medium".to_string(),
            whisper_language: String::new(),
            whisper_engine_path: String::new(),
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

/// A settings file's contents. A corrupt or partial file gives the defaults
/// rather than stopping the app booting.
fn parse_settings(bytes: &[u8]) -> Settings {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return Settings::default();
    };
    // From before the chat had models of its own: it used `model`, so keep
    // chatting with whatever that was set to.
    let predates_chat_models = value.get("chatModels").is_none();
    let mut settings: Settings = serde_json::from_value(value).unwrap_or_default();
    if predates_chat_models && !settings.model.trim().is_empty() {
        settings.chat_models = vec![settings.model.trim().to_string()];
    }
    settings
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> AppResult<Settings> {
    let path = settings_path(&app)?;
    match std::fs::read(&path) {
        Ok(bytes) => Ok(parse_settings(&bytes)),
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
            "No OpenRouter API key saved. Add one in Settings before using the AI features.",
        ),
        other => AppError::from(other),
    })?;
    if key.trim().is_empty() {
        return Err(AppError::msg("The saved OpenRouter API key is empty."));
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::{parse_settings, Settings};

    #[test]
    fn old_style_notes_become_fill_instructions() {
        let old = r#"{"model":"x","styleNotes":"Norwegian, dry humour","contextLines":12}"#;
        let settings: Settings = serde_json::from_str(old).unwrap();
        assert_eq!(settings.fill_instructions, "Norwegian, dry humour");
        assert_eq!(settings.fill_takes, 3);
        assert_eq!(settings.fill_latitude, "open");
    }

    #[test]
    fn a_settings_file_from_before_autocomplete_gets_its_defaults() {
        let old = r#"{"model":"x","fillTakes":2}"#;
        let settings: Settings = serde_json::from_str(old).unwrap();
        assert!(settings.ghost_enabled);
        assert_eq!(settings.ghost_model, "google/gemini-2.5-flash-lite");
        assert_eq!(settings.ghost_delay_ms, 350);
        assert_eq!(settings.chat_lines_before, 10);
    }

    #[test]
    fn a_settings_file_from_before_chat_models_chats_with_its_model() {
        let settings = parse_settings(br#"{"model":"openai/gpt-5"}"#);
        assert_eq!(settings.chat_models, ["openai/gpt-5"]);
        assert_eq!(settings.chat_effort, "");
        assert_eq!(settings.vision_model, "");
    }

    #[test]
    fn a_saved_chat_model_list_is_kept_as_it_is() {
        let settings = parse_settings(br#"{"model":"x","chatModels":["a/b","c/d"]}"#);
        assert_eq!(settings.chat_models, ["a/b", "c/d"]);
        let emptied = parse_settings(br#"{"model":"x","chatModels":[]}"#);
        assert!(emptied.chat_models.is_empty());
    }

    #[test]
    fn a_corrupt_settings_file_gives_the_defaults() {
        let settings = parse_settings(b"{not json");
        assert_eq!(settings.chat_models, ["anthropic/claude-sonnet-4.5"]);
    }
}
