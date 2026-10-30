//! One turn of a `/continue` run from the chat panel.
//!
//! The run itself — the tools, what they do to the cues, when to stop — lives
//! in the frontend (`src/lib/agent.ts`). This side holds the API key and makes
//! each call, sharing the chat's cancel so Stop and Reset end a run too.

use serde::Deserialize;
use serde_json::Value;
use tauri::State;

use crate::ai::chat_completion_tools;
use crate::chat::{ChatState, CANCELLED, EFFORTS, MAX_TOKENS_CEILING, MIN_TOKENS};
use crate::error::{AppError, AppResult};
use crate::settings::read_api_key;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequest {
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
    /// OpenAI-style messages, tool turns included.
    pub messages: Vec<Value>,
    pub tools: Vec<Value>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

/// Why the request cannot be sent, if it cannot.
fn check(request: &AgentRequest) -> AppResult<()> {
    if request.model.trim().is_empty() {
        return Err(AppError::msg("No chat model selected. Add one under Chat in Settings."));
    }
    if let Some(effort) = &request.reasoning_effort {
        if !EFFORTS.contains(&effort.as_str()) {
            return Err(AppError::msg(format!("Unknown reasoning effort \"{effort}\".")));
        }
    }
    if request.messages.is_empty() || request.tools.is_empty() {
        return Err(AppError::msg("The continue request is empty."));
    }
    Ok(())
}

#[tauri::command]
pub async fn ai_agent_step(
    state: State<'_, ChatState>,
    request: AgentRequest,
) -> AppResult<Value> {
    check(&request)?;
    let key = read_api_key()?;

    let task = tauri::async_runtime::spawn(async move {
        chat_completion_tools(
            &key,
            &request.model,
            &request.messages,
            &request.tools,
            request.temperature,
            request.max_tokens.clamp(MIN_TOKENS, MAX_TOKENS_CEILING),
            request.reasoning_effort.as_deref(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(model: &str, effort: Option<&str>, messages: Vec<Value>) -> AgentRequest {
        AgentRequest {
            model: model.into(),
            temperature: 0.8,
            max_tokens: 4000,
            messages,
            tools: vec![json!({"type": "function", "function": {"name": "finish"}})],
            reasoning_effort: effort.map(Into::into),
        }
    }

    #[test]
    fn a_complete_request_is_accepted() {
        let messages = vec![json!({"role": "user", "content": "/continue"})];
        assert!(check(&request("m", Some("high"), messages)).is_ok());
    }

    #[test]
    fn a_missing_model_unknown_effort_or_empty_conversation_is_refused() {
        let messages = || vec![json!({"role": "user", "content": "go"})];
        assert!(check(&request(" ", None, messages())).is_err());
        assert!(check(&request("m", Some("max"), messages())).is_err());
        assert!(check(&request("m", None, vec![])).is_err());
        let no_tools = AgentRequest { tools: vec![], ..request("m", None, messages()) };
        assert!(check(&no_tools).is_err());
    }
}
