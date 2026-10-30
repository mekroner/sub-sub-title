//! OpenRouter chat completions, called from Rust so the API key never reaches
//! the webview. Shared by Fill, story beats, ghost text, and the proofreader.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop: Option<&'a [&'a str]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<Reasoning<'a>>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    stream: bool,
}

/// OpenRouter's provider-neutral reasoning setting.
#[derive(Serialize)]
struct Reasoning<'a> {
    effort: &'a str,
    /// The thinking is not shown anywhere, so it need not be sent back.
    exclude: bool,
}

impl<'a> ChatRequest<'a> {
    /// A plain request to `model`, or why there can be none.
    fn new(
        model: &'a str,
        messages: &'a [ChatTurn],
        temperature: f32,
        max_tokens: u32,
    ) -> AppResult<Self> {
        let model = model.trim();
        if model.is_empty() {
            return Err(AppError::msg("No model selected. Choose one in Settings."));
        }
        Ok(Self {
            model,
            messages,
            temperature: Some(temperature.clamp(0.0, 2.0)),
            max_tokens,
            stop: None,
            reasoning: None,
            stream: false,
        })
    }

    /// Asks a reasoning model to think at `effort` first. Its temperature is
    /// left to it: reasoning models fix their own, and some refuse any other.
    fn with_effort(mut self, effort: &'a str) -> Self {
        self.temperature = None;
        self.reasoning = Some(Reasoning {
            effort,
            exclude: true,
        });
        self
    }
}

/// One client for the life of the app, so its connection pool is reused.
/// Ghost text calls on every typing pause, and a fresh client per request
/// would pay a TLS handshake each time.
fn http_client() -> AppResult<&'static reqwest::Client> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    // Without a timeout a stalled request hangs forever, and the proofreader's
    // cancel button can only take effect between requests.
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(AppError::from)?;
    Ok(CLIENT.get_or_init(|| client))
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
    chat_completion_with_stop(key, model, messages, temperature, max_tokens, None).await
}

/// `chat_completion`, ending the reply at the first of `stop`.
pub async fn chat_completion_with_stop(
    key: &str,
    model: &str,
    messages: &[ChatTurn],
    temperature: f32,
    max_tokens: u32,
    stop: Option<&[&str]>,
) -> AppResult<String> {
    let body = ChatRequest {
        stop,
        ..ChatRequest::new(model, messages, temperature, max_tokens)?
    };
    let resp = send_chat(key, &body).await?;

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

async fn send_chat(key: &str, body: &ChatRequest<'_>) -> AppResult<reqwest::Response> {
    Ok(http_client()?
        .post(format!("{OPENROUTER_BASE}/chat/completions"))
        .bearer_auth(key)
        .header("HTTP-Referer", APP_URL)
        .header("X-Title", APP_TITLE)
        .json(body)
        .send()
        .await?)
}

/// A chat completion delivered piece by piece, for replies a person watches
/// being written. Returns once the stream ends; `on_delta` has seen all of it.
/// With an `effort`, a reasoning model thinks first; `temperature` is unused.
pub async fn chat_completion_stream(
    key: &str,
    model: &str,
    messages: &[ChatTurn],
    temperature: f32,
    max_tokens: u32,
    effort: Option<&str>,
    mut on_delta: impl FnMut(&str),
) -> AppResult<()> {
    use futures_util::StreamExt;

    let mut body = ChatRequest {
        stream: true,
        ..ChatRequest::new(model, messages, temperature, max_tokens)?
    };
    if let Some(effort) = effort {
        body = body.with_effort(effort);
    }
    let resp = send_chat(key, &body).await?;

    let status = resp.status();
    if !status.is_success() {
        // An error before the stream starts is an ordinary JSON body.
        let text = resp.text().await?;
        let message = serde_json::from_str::<ChatResponse>(&text)
            .ok()
            .and_then(|r| r.error)
            .and_then(|e| e.message)
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(AppError::msg(format!("OpenRouter error: {message}")));
    }

    let mut lines = SseLines::default();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        for line in lines.push(&chunk?) {
            match parse_sse_line(&line) {
                SseEvent::Delta(text) => on_delta(&text),
                SseEvent::Done => return Ok(()),
                SseEvent::Error(message) => {
                    return Err(AppError::msg(format!("OpenRouter error: {message}")))
                }
                SseEvent::Ignore => {}
            }
        }
    }
    Ok(())
}

/// Splits a byte stream into lines, holding back a line a chunk cut in half.
/// Bytes rather than text, so a multi-byte character split across chunks
/// survives.
#[derive(Default)]
pub(crate) struct SseLines {
    pending: Vec<u8>,
}

impl SseLines {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(at) = self.pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=at).collect();
            let text = String::from_utf8_lossy(&line);
            out.push(text.trim_end_matches(['\n', '\r']).to_string());
        }
        out
    }
}

#[derive(Debug, PartialEq)]
pub(crate) enum SseEvent {
    Delta(String),
    Done,
    Error(String),
    Ignore,
}

#[derive(Deserialize)]
struct StreamChunk {
    choices: Option<Vec<StreamChoice>>,
    error: Option<ApiError>,
}

#[derive(Deserialize)]
struct StreamChoice {
    delta: Option<ChoiceMessage>,
}

/// One line of an OpenRouter event stream. Blank lines, `: comment` keep-alives
/// and chunks with no text in them are all `Ignore`.
pub(crate) fn parse_sse_line(line: &str) -> SseEvent {
    let Some(data) = line.strip_prefix("data:") else {
        return SseEvent::Ignore;
    };
    let data = data.trim();
    if data == "[DONE]" {
        return SseEvent::Done;
    }
    let Ok(chunk) = serde_json::from_str::<StreamChunk>(data) else {
        return SseEvent::Ignore;
    };
    if let Some(err) = chunk.error {
        return SseEvent::Error(err.message.unwrap_or_else(|| "unknown error".into()));
    }
    chunk
        .choices
        .and_then(|c| c.into_iter().next())
        .and_then(|c| c.delta)
        .and_then(|d| d.content)
        .filter(|text| !text.is_empty())
        .map(SseEvent::Delta)
        .unwrap_or(SseEvent::Ignore)
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
    use super::{parse_candidates, parse_sse_line, ChatRequest, ChatTurn, SseEvent, SseLines};

    fn request<'a>(messages: &'a [ChatTurn], stop: Option<&'a [&'a str]>) -> ChatRequest<'a> {
        ChatRequest {
            stop,
            ..ChatRequest::new(" test/model ", messages, 0.3, 40).unwrap()
        }
    }

    #[test]
    fn a_non_streaming_request_omits_the_stream_field() {
        let json = serde_json::to_value(request(&[], None)).unwrap();
        assert!(json.get("stream").is_none());
    }

    #[test]
    fn a_plain_request_sends_its_temperature_and_no_reasoning() {
        let json = serde_json::to_value(request(&[], None)).unwrap();
        assert_eq!(json["model"], "test/model");
        assert!((json["temperature"].as_f64().unwrap() - 0.3).abs() < 1e-6);
        assert!(json.get("reasoning").is_none());
    }

    #[test]
    fn a_request_with_effort_sends_reasoning_and_no_temperature() {
        let json = serde_json::to_value(request(&[], None).with_effort("high")).unwrap();
        assert_eq!(json["reasoning"], serde_json::json!({"effort": "high", "exclude": true}));
        assert!(json.get("temperature").is_none());
    }

    #[test]
    fn a_request_without_a_model_is_refused() {
        assert!(ChatRequest::new("  ", &[], 0.3, 40).is_err());
    }

    #[test]
    fn a_stream_line_with_text_is_a_delta() {
        let line = r#"data: {"choices":[{"delta":{"content":"Hel"}}]}"#;
        assert_eq!(parse_sse_line(line), SseEvent::Delta("Hel".into()));
    }

    #[test]
    fn done_comments_and_empty_deltas_are_told_apart() {
        assert_eq!(parse_sse_line("data: [DONE]"), SseEvent::Done);
        assert_eq!(parse_sse_line(": OPENROUTER PROCESSING"), SseEvent::Ignore);
        assert_eq!(parse_sse_line(""), SseEvent::Ignore);
        let role_only = r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#;
        assert_eq!(parse_sse_line(role_only), SseEvent::Ignore);
    }

    #[test]
    fn an_error_mid_stream_is_reported() {
        let line = r#"data: {"error":{"message":"rate limited"}}"#;
        assert_eq!(parse_sse_line(line), SseEvent::Error("rate limited".into()));
    }

    #[test]
    fn a_line_split_across_chunks_is_held_until_complete() {
        let mut lines = SseLines::default();
        assert!(lines.push(b"data: {\"a\"").is_empty());
        assert_eq!(lines.push(b":1}\r\n\ndata: [DO"), vec!["data: {\"a\":1}", ""]);
        assert_eq!(lines.push(b"NE]\n"), vec!["data: [DONE]"]);
    }

    #[test]
    fn a_character_split_across_chunks_survives() {
        let bytes = "data: ø\n".as_bytes();
        let mut lines = SseLines::default();
        assert!(lines.push(&bytes[..7]).is_empty());
        assert_eq!(lines.push(&bytes[7..]), vec!["data: ø"]);
    }

    #[test]
    fn a_request_without_stop_sequences_omits_the_field() {
        let json = serde_json::to_value(request(&[], None)).unwrap();
        assert!(json.get("stop").is_none());
    }

    #[test]
    fn a_request_with_stop_sequences_sends_them() {
        let json = serde_json::to_value(request(&[], Some(&["

"]))).unwrap();
        assert_eq!(json["stop"], serde_json::json!(["

"]));
    }

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
