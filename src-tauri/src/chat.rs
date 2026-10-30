//! The chat panel: a conversation about the project, streamed as it is written.
//!
//! The conversation — system prompt, script excerpts, history — is assembled
//! in the frontend (`src/lib/chat.ts`). This side holds the API key, streams the
//! reply back over a channel, and cancels a reply the writer stopped or reset.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::ai::{chat_completion_stream, ChatTurn};
use crate::error::{AppError, AppResult};
use crate::settings::read_api_key;

/// The error a stopped or superseded reply returns. The frontend marks the
/// reply as stopped rather than showing it.
const CANCELLED: &str = "cancelled";

/// Room for a long, list-heavy answer after a model's thinking, which counts
/// against the same budget, and a ceiling on a malformed request.
const MAX_TOKENS_CEILING: u32 = 16_000;
const MIN_TOKENS: u32 = 256;

/// The reasoning efforts the chat panel offers.
const EFFORTS: [&str; 3] = ["low", "medium", "high"];

type AbortFn = Box<dyn FnOnce() + Send>;

#[derive(Default)]
pub struct ChatState {
    in_flight: Mutex<Option<AbortFn>>,
}

impl ChatState {
    /// Stores the abort for a new reply, aborting whichever one it replaces.
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
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub messages: Vec<ChatMessage>,
    /// Absent leaves reasoning to the model.
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatEvent {
    Delta { text: String },
}

fn role(name: &str) -> Option<&'static str> {
    match name {
        "system" => Some("system"),
        "user" => Some("user"),
        "assistant" => Some("assistant"),
        _ => None,
    }
}

/// The turns to send, or why the request cannot be sent.
fn turns(request: &ChatRequest) -> AppResult<Vec<ChatTurn>> {
    if request.model.trim().is_empty() {
        return Err(AppError::msg("No chat model selected. Add one under Chat in Settings."));
    }
    if let Some(effort) = &request.reasoning_effort {
        if !EFFORTS.contains(&effort.as_str()) {
            return Err(AppError::msg(format!("Unknown reasoning effort \"{effort}\".")));
        }
    }
    match request.messages.last() {
        Some(last) if last.role == "user" && !last.content.trim().is_empty() => {}
        _ => return Err(AppError::msg("The chat request has no question in it.")),
    }
    request
        .messages
        .iter()
        .map(|m| {
            role(&m.role)
                .map(|role| ChatTurn {
                    role,
                    content: m.content.clone(),
                })
                .ok_or_else(|| AppError::msg(format!("Unknown chat role \"{}\".", m.role)))
        })
        .collect()
}

#[tauri::command]
pub async fn ai_chat(
    state: State<'_, ChatState>,
    request: ChatRequest,
    on_event: Channel<ChatEvent>,
) -> AppResult<()> {
    let messages = turns(&request)?;
    let key = read_api_key()?;

    let task = tauri::async_runtime::spawn(async move {
        chat_completion_stream(
            &key,
            &request.model,
            &messages,
            request.temperature,
            request.max_tokens.clamp(MIN_TOKENS, MAX_TOKENS_CEILING),
            request.reasoning_effort.as_deref(),
            |text| {
                let _ = on_event.send(ChatEvent::Delta { text: text.to_string() });
            },
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

/// Stop, Reset, or a project switch: the reply has nowhere to go.
#[tauri::command]
pub fn cancel_chat(state: State<'_, ChatState>) {
    state.replace(None);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.into(),
            content: content.into(),
        }
    }

    fn request(model: &str, messages: Vec<ChatMessage>) -> ChatRequest {
        ChatRequest {
            model: model.into(),
            temperature: 0.9,
            max_tokens: 1000,
            messages,
            reasoning_effort: None,
        }
    }

    #[test]
    fn a_known_effort_is_accepted_and_an_unknown_one_refused() {
        let with = |effort: &str| ChatRequest {
            reasoning_effort: Some(effort.into()),
            ..request("m", vec![message("user", "hi")])
        };
        assert!(turns(&with("high")).is_ok());
        assert!(turns(&with("max")).is_err());
        assert!(turns(&with("")).is_err());
    }

    #[test]
    fn a_conversation_ending_in_a_question_is_accepted() {
        let got = turns(&request(
            "m",
            vec![
                message("system", "rules"),
                message("user", "hi"),
                message("assistant", "hello"),
                message("user", "what next?"),
            ],
        ))
        .unwrap();
        let roles: Vec<_> = got.iter().map(|t| t.role).collect();
        assert_eq!(roles, ["system", "user", "assistant", "user"]);
    }

    #[test]
    fn a_request_without_a_final_question_is_refused() {
        assert!(turns(&request("m", vec![])).is_err());
        assert!(turns(&request("m", vec![message("assistant", "hello")])).is_err());
        assert!(turns(&request("m", vec![message("user", "  ")])).is_err());
    }

    #[test]
    fn an_unknown_role_or_missing_model_is_refused() {
        assert!(turns(&request("m", vec![message("tool", "x"), message("user", "hi")])).is_err());
        assert!(turns(&request(" ", vec![message("user", "hi")])).is_err());
    }

    #[test]
    fn a_new_reply_aborts_the_one_it_replaces() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let state = ChatState::default();
        let aborted = Arc::new(AtomicBool::new(false));
        let flag = aborted.clone();
        state.replace(Some(Box::new(move || flag.store(true, Ordering::SeqCst))));
        assert!(!aborted.load(Ordering::SeqCst));

        state.replace(None);
        assert!(aborted.load(Ordering::SeqCst));
    }
}
