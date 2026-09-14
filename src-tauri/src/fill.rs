//! The Fill feature: writes dialogue into timed slots.
//!
//! The prompt is assembled in the frontend (`src/lib/fill.ts`), not here, so
//! the dialog can show the exact request before it is sent and Settings can
//! offer the built-in guidance as editable text. This side only holds the API
//! key and makes the call, and the reply is parsed back in the frontend too.

use serde::Deserialize;

use crate::ai::{ChatTurn, chat_completion};
use crate::error::{AppError, AppResult};
use crate::settings::read_api_key;

/// Enough for four takes of eight slots with room to spare, and a ceiling on
/// what a malformed request can spend.
const MAX_TOKENS_CEILING: u32 = 8_000;
const MIN_TOKENS: u32 = 300;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FillRequest {
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub system: String,
    pub user: String,
}

#[tauri::command]
pub async fn ai_fill(request: FillRequest) -> AppResult<String> {
    if request.system.trim().is_empty() || request.user.trim().is_empty() {
        return Err(AppError::msg("The fill request is empty."));
    }
    let key = read_api_key()?;

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

    let content = chat_completion(
        &key,
        &request.model,
        &messages,
        request.temperature,
        request.max_tokens.clamp(MIN_TOKENS, MAX_TOKENS_CEILING),
    )
    .await?;

    if content.trim().is_empty() {
        return Err(AppError::msg("The model returned an empty reply."));
    }
    Ok(content)
}
