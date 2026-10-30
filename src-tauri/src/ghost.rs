//! Ghost text: the short grey continuation shown while a cue is being typed.
//!
//! The prompt is built in the frontend (`src/lib/ghost.ts`), like Fill's. This
//! side holds the API key, makes the call, and cancels a request a newer
//! keystroke has made pointless — a burst of typing leaves at most one live.

use std::sync::Mutex;

use serde::Deserialize;
use tauri::State;

use crate::ai::{ChatTurn, chat_completion_with_stop};
use crate::error::{AppError, AppResult};
use crate::settings::read_api_key;

/// The error a superseded or cancelled request returns. The frontend drops it
/// silently rather than showing it.
const CANCELLED: &str = "cancelled";

/// A suggestion is one subtitle line; this caps what a malformed request spends.
const MAX_TOKENS_CEILING: u32 = 120;
const MIN_TOKENS: u32 = 8;

/// Predicting the obvious rest of a line, not inventing: keep sampling tight.
const TEMPERATURE: f32 = 0.3;

/// A suggestion never spans a paragraph break.
const STOP: &[&str] = &["\n\n"];

type AbortFn = Box<dyn FnOnce() + Send>;

#[derive(Default)]
pub struct GhostState {
    in_flight: Mutex<Option<AbortFn>>,
}

impl GhostState {
    /// Stores the abort for a new request, aborting whichever one it replaces.
    fn replace(&self, abort: Option<AbortFn>) {
        let previous = {
            let mut slot = self.in_flight.lock().unwrap_or_else(|p| p.into_inner());
            std::mem::replace(&mut *slot, abort)
        };
        if let Some(previous) = previous {
            previous();
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhostRequest {
    pub model: String,
    pub system: String,
    pub user: String,
    pub max_tokens: u32,
}

fn validate(request: &GhostRequest) -> AppResult<()> {
    if request.system.trim().is_empty() || request.user.trim().is_empty() {
        return Err(AppError::msg("The autocomplete request is empty."));
    }
    if request.model.trim().is_empty() {
        return Err(AppError::msg(
            "No autocomplete model selected. Choose one in Settings.",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn ai_ghost(state: State<'_, GhostState>, request: GhostRequest) -> AppResult<String> {
    validate(&request)?;
    let key = read_api_key()?;

    let task = tauri::async_runtime::spawn(async move {
        let messages = [
            ChatTurn {
                role: "system",
                content: request.system,
            },
            ChatTurn {
                role: "user",
                content: request.user,
            },
        ];
        chat_completion_with_stop(
            &key,
            &request.model,
            &messages,
            TEMPERATURE,
            request.max_tokens.clamp(MIN_TOKENS, MAX_TOKENS_CEILING),
            Some(STOP),
        )
        .await
    });

    let abort = task.inner().abort_handle();
    state.replace(Some(Box::new(move || abort.abort())));

    match task.await {
        Ok(result) => result,
        Err(tauri::Error::JoinError(e)) if e.is_cancelled() => Err(AppError::msg(CANCELLED)),
        Err(e) => Err(AppError::from(e)),
    }
}

/// Called when the cue loses focus: the answer would have nowhere to go.
#[tauri::command]
pub fn cancel_ghost(state: State<'_, GhostState>) {
    state.replace(None);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(system: &str, user: &str, model: &str) -> GhostRequest {
        GhostRequest {
            model: model.into(),
            system: system.into(),
            user: user.into(),
            max_tokens: 40,
        }
    }

    #[test]
    fn an_empty_prompt_is_refused() {
        assert!(validate(&request("  ", "typed", "m")).is_err());
        assert!(validate(&request("rules", "\n", "m")).is_err());
    }

    #[test]
    fn a_missing_model_is_refused() {
        assert!(validate(&request("rules", "typed", " ")).is_err());
    }

    #[test]
    fn a_complete_request_is_accepted() {
        assert!(validate(&request("rules", "typed", "google/gemini-2.5-flash-lite")).is_ok());
    }

    #[test]
    fn a_new_request_aborts_the_one_it_replaces() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};

        let state = GhostState::default();
        let aborted = Arc::new(AtomicBool::new(false));
        let flag = aborted.clone();
        state.replace(Some(Box::new(move || flag.store(true, Ordering::SeqCst))));
        assert!(!aborted.load(Ordering::SeqCst));

        state.replace(None);
        assert!(aborted.load(Ordering::SeqCst));
    }
}
