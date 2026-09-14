//! OpenRouter chat completions, called from Rust so the API key never reaches
//! the webview. Shared by Fill, story beats, and the proofreader.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

const OPENROUTER_BASE: &str = "https://openrouter.ai/api/v1";
const APP_TITLE: &str = "sub-sub-title";
const APP_URL: &str = "https://github.com/local/sub-sub-title";
/// Long enough for a slow model on a long batch, short enough that a stalled
/// request eventually gives up instead of pinning the UI forever.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// One line of the script, as the frontend sends it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextLine {
    pub speaker: String,
    pub text: String,
}

/// One turn of a chat request.
#[derive(Serialize)]
pub struct ChatTurn {
    pub role: &'static str,
    pub content: String,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatTurn],
    temperature: f32,
    max_tokens: u32,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Option<Vec<Choice>>,
    error: Option<ApiError>,
}

#[derive(Deserialize)]
struct Choice {
    message: Option<ChoiceMessage>,
}

#[derive(Deserialize)]
struct ChoiceMessage {
    content: Option<String>,
}

#[derive(Deserialize)]
struct ApiError {
    message: Option<String>,
}

/// Models are inconsistent about honouring "reply with JSON only", so accept a
/// fenced block or a bare array, and fall back to line-splitting.
pub(crate) fn parse_candidates(content: &str, wanted: usize) -> Vec<String> {
    let cleaned = content.trim();

    // Strip a ```json ... ``` fence if present.
    let cleaned = if let Some(rest) = cleaned.strip_prefix("```") {
        let rest = rest.strip_prefix("json").unwrap_or(rest);
        rest.trim_start_matches('\n')
            .rsplit_once("```")
            .map(|(body, _)| body)
            .unwrap_or(rest)
    } else {
        cleaned
    };

    // Prefer a real JSON array anywhere in the text.
    if let (Some(start), Some(end)) = (cleaned.find('['), cleaned.rfind(']')) {
        if start < end {
            if let Ok(items) = serde_json::from_str::<Vec<String>>(&cleaned[start..=end]) {
                let out: Vec<String> = items
                    .into_iter()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if !out.is_empty() {
                    return out;
                }
            }
        }
    }

    // Fall back: treat non-empty lines as candidates, dropping list markers.
    cleaned
        .lines()
        .map(|l| {
            l.trim()
                .trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == ')')
                .trim_start_matches(['-', '*', '"'])
                .trim_end_matches('"')
                .trim()
                .to_string()
        })
        .filter(|l| !l.is_empty())
        .take(wanted.max(1))
        .collect()
}

/// A single chat completion, returning the assistant's text.
///
/// Shared by every AI feature so they cannot drift apart in how they
/// authenticate, time out, or report an OpenRouter failure.
pub async fn chat_completion(
    key: &str,
    model: &str,
    messages: &[ChatTurn],
    temperature: f32,
    max_tokens: u32,
) -> AppResult<String> {
    if model.trim().is_empty() {
        return Err(AppError::msg("No model selected. Choose one in Settings."));
    }

    let body = ChatRequest {
        model: model.trim(),
        messages,
        temperature: temperature.clamp(0.0, 2.0),
        max_tokens,
    };

    // Without a timeout a stalled request hangs forever, and the proofreader's
    // cancel button can only take effect between requests.
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(AppError::from)?;

    let resp = client
        .post(format!("{OPENROUTER_BASE}/chat/completions"))
        .bearer_auth(key)
        .header("HTTP-Referer", APP_URL)
        .header("X-Title", APP_TITLE)
        .json(&body)
        .send()
        .await?;

    let status = resp.status();
    let text = resp.text().await?;
    let parsed: ChatResponse = serde_json::from_str(&text).map_err(|_| {
        AppError::msg(format!(
            "Unexpected response from OpenRouter (HTTP {status}): {}",
            text.chars().take(300).collect::<String>()
        ))
    })?;

    if let Some(err) = parsed.error {
        return Err(AppError::msg(format!(
            "OpenRouter error: {}",
            err.message.unwrap_or_else(|| status.to_string())
        )));
    }

    if !status.is_success() {
        return Err(AppError::msg(format!("OpenRouter returned HTTP {status}.")));
    }

    parsed
        .choices
        .and_then(|c| c.into_iter().next())
        .and_then(|c| c.message)
        .and_then(|m| m.content)
        .ok_or_else(|| AppError::msg("OpenRouter returned no completion."))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize)]
struct ModelsResponse {
    data: Option<Vec<ModelEntry>>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
    name: Option<String>,
}

/// Lets Settings offer a real picker instead of relying on a hardcoded model id
/// that may have been retired.
#[tauri::command]
pub async fn list_models() -> AppResult<Vec<ModelInfo>> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{OPENROUTER_BASE}/models"))
        .header("HTTP-Referer", APP_URL)
        .header("X-Title", APP_TITLE)
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(AppError::msg(format!(
            "Could not fetch the model list (HTTP {}).",
            resp.status()
        )));
    }

    let parsed: ModelsResponse = resp.json().await?;
    let mut models: Vec<ModelInfo> = parsed
        .data
        .unwrap_or_default()
        .into_iter()
        .map(|m| ModelInfo {
            name: m.name.clone().unwrap_or_else(|| m.id.clone()),
            id: m.id,
        })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::parse_candidates;

    #[test]
    fn parses_a_bare_json_array() {
        let got = parse_candidates(r#"["one", "two"]"#, 3);
        assert_eq!(got, vec!["one", "two"]);
    }

    #[test]
    fn parses_a_fenced_json_array() {
        let got = parse_candidates("```json\n[\"a\", \"b\"]\n```", 3);
        assert_eq!(got, vec!["a", "b"]);
    }

    #[test]
    fn falls_back_to_numbered_lines() {
        let got = parse_candidates("1. first line\n2. second line", 2);
        assert_eq!(got, vec!["first line", "second line"]);
    }
}
