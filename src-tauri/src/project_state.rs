//! Which project was open last, and the recently-opened list. Stored as
//! `state.json` beside `settings.json` in the app config directory, so it
//! survives reinstalls of the video files themselves.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// Longer than this and the menu stops being a shortcut.
const RECENT_LIMIT: usize = 10;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    /// Absolute path of the `.sstproj` file.
    pub path: String,
    /// The video it referenced when last opened, for the menu subtitle.
    pub video_path: String,
    /// Milliseconds since the epoch; the list is kept newest-first anyway.
    pub opened_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AppState {
    /// Reopened on the next launch.
    pub last_project: Option<String>,
    pub recent_projects: Vec<RecentProject>,
}

fn state_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::msg(format!("No config directory: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("state.json"))
}

fn read_state(app: &AppHandle) -> AppResult<AppState> {
    let path = state_path(app)?;
    match std::fs::read(&path) {
        // A corrupt state file must never stop the app booting; the worst case
        // is an empty recents list.
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
        Err(_) => Ok(AppState::default()),
    }
}

fn write_state(app: &AppHandle, state: &AppState) -> AppResult<()> {
    let path = state_path(app)?;
    std::fs::write(&path, serde_json::to_vec_pretty(state)?)?;
    Ok(())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn load_app_state(app: AppHandle) -> AppResult<AppState> {
    read_state(&app)
}

/// Records a project as the most recent one, and as the project to reopen.
#[tauri::command]
pub fn remember_project(
    app: AppHandle,
    path: String,
    video_path: String,
) -> AppResult<AppState> {
    let mut state = read_state(&app)?;
    state.recent_projects.retain(|entry| entry.path != path);
    state.recent_projects.insert(
        0,
        RecentProject {
            path: path.clone(),
            video_path,
            opened_at: now_millis(),
        },
    );
    state.recent_projects.truncate(RECENT_LIMIT);
    state.last_project = Some(path);
    write_state(&app, &state)?;
    Ok(state)
}

/// Drops a project that could not be opened (moved, renamed, deleted).
#[tauri::command]
pub fn forget_project(app: AppHandle, path: String) -> AppResult<AppState> {
    let mut state = read_state(&app)?;
    state.recent_projects.retain(|entry| entry.path != path);
    if state.last_project.as_deref() == Some(path.as_str()) {
        state.last_project = None;
    }
    write_state(&app, &state)?;
    Ok(state)
}

/// Used when the user starts a new, unsaved project: there is nothing to reopen.
#[tauri::command]
pub fn clear_last_project(app: AppHandle) -> AppResult<AppState> {
    let mut state = read_state(&app)?;
    state.last_project = None;
    write_state(&app, &state)?;
    Ok(state)
}
