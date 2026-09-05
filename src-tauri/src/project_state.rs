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
    /// Seconds into the video when the project was last open, so reopening it
    /// resumes where the user stopped. `default` matters: without it a state
    /// file written before this field existed fails to parse, and `read_state`
    /// would silently fall back to an empty recents list.
    #[serde(default)]
    pub position: f64,
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
    // Carry the saved position across the re-insert: this runs *while* opening
    // the project, and dropping it here would erase the position every time.
    let position = state
        .recent_projects
        .iter()
        .find(|entry| entry.path == path)
        .map_or(0.0, |entry| entry.position);
    state.recent_projects.retain(|entry| entry.path != path);
    state.recent_projects.insert(
        0,
        RecentProject {
            path: path.clone(),
            video_path,
            opened_at: now_millis(),
            position,
        },
    );
    state.recent_projects.truncate(RECENT_LIMIT);
    state.last_project = Some(path);
    write_state(&app, &state)?;
    Ok(state)
}

/// Records how far playback had reached. Called on a timer, so it returns
/// nothing: the frontend has no reason to re-render for its own bookmark. A
/// project not in the recents list is ignored rather than added — the list is
/// the record of what was *opened*.
#[tauri::command]
pub fn remember_position(app: AppHandle, path: String, position: f64) -> AppResult<()> {
    let mut state = read_state(&app)?;
    let Some(entry) = state
        .recent_projects
        .iter_mut()
        .find(|entry| entry.path == path)
    else {
        return Ok(());
    };
    entry.position = if position.is_finite() && position > 0.0 {
        position
    } else {
        0.0
    };
    write_state(&app, &state)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The field was added after the first releases, so a state file written
    /// without it must still load. Without `#[serde(default)]` this fails, and
    /// `read_state` turns the failure into an empty recents list.
    #[test]
    fn reads_a_state_file_written_before_positions_existed() {
        let json = r#"{
            "lastProject": "C:/a.sstproj",
            "recentProjects": [
                { "path": "C:/a.sstproj", "videoPath": "C:/a.mp4", "openedAt": 17 }
            ]
        }"#;
        let state: AppState = serde_json::from_str(json).expect("should still parse");
        assert_eq!(state.recent_projects.len(), 1);
        assert_eq!(state.recent_projects[0].position, 0.0);
    }

    #[test]
    fn round_trips_a_position() {
        let state = AppState {
            last_project: None,
            recent_projects: vec![RecentProject {
                path: "C:/a.sstproj".to_string(),
                video_path: "C:/a.mp4".to_string(),
                opened_at: 17,
                position: 42.5,
            }],
        };
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("\"position\":42.5"));
        let back: AppState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.recent_projects[0].position, 42.5);
    }
}
