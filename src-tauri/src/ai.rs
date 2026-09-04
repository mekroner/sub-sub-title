//! The continue-feature: OpenRouter chat completions, called from Rust so the
//! API key never reaches the webview.

use crate::error::{AppError, AppResult};
use crate::settings::read_api_key;
use serde::{Deserialize, Serialize};

const OPENROUTER_BASE: &str = "https://openrouter.ai/api/v1";
const APP_TITLE: &str = "sub-sub-title";
const APP_URL: &str = "https://github.com/local/sub-sub-title";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextLine {
    pub speaker: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinueRequest {
    pub model: String,
    pub temperature: f32,
    pub candidate_count: u32,
    pub style_notes: String,
    /// The speaker the new line should be written for.
    pub speaker_name: String,
    pub voice_notes: String,
    /// Preceding dialogue, oldest first.
    pub context: Vec<ContextLine>,
}

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: String,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage<'a>>,
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

fn build_system_prompt(req: &ContinueRequest) -> String {
    let mut s = String::from(
        "You are helping write dialogue for a subtitled video. Given the recent lines of a \
         scene, propose the single next line of dialogue for one specific speaker.\n\n\
         Rules:\n\
         - Write only what the speaker says. No speaker name prefix, no quotation marks, \
         no stage directions, no narration.\n\
         - Keep it to subtitle length: at most about 15 words, one or two short sentences.\n\
         - Match the language, register, and tone of the surrounding lines.\n\
         - Continue the scene naturally. Do not summarise or conclude it.\n",
    );

    if !req.style_notes.trim().is_empty() {
        s.push_str(&format!("\nOverall style guidance: {}\n", req.style_notes.trim()));
    }

    s.push_str(&format!(
        "\nRespond with a JSON array of exactly {} distinct candidate lines, and nothing else. \
         Example format: [\"first candidate\", \"second candidate\"]",
        req.candidate_count.clamp(1, 6)
    ));
    s
}

fn build_user_prompt(req: &ContinueRequest) -> String {
    let mut s = String::new();

    if req.context.is_empty() {
        s.push_str("There are no preceding lines; this is the opening of the scene.\n");
    } else {
        s.push_str("Recent dialogue, in order:\n\n");
        for line in &req.context {
            let who = if line.speaker.trim().is_empty() {
                "UNKNOWN"
            } else {
                line.speaker.trim()
            };
            s.push_str(&format!("{}: {}\n", who, line.text.replace('\n', " ")));
        }
    }

    let speaker = if req.speaker_name.trim().is_empty() {
        "the next speaker"
    } else {
        req.speaker_name.trim()
    };
    s.push_str(&format!("\nWrite the next line for: {speaker}"));

    if !req.voice_notes.trim().is_empty() {
        s.push_str(&format!(
            "\nHow {speaker} speaks: {}",
            req.voice_notes.trim()
        ));
    }
    s
}

/// Models are inconsistent about honouring "reply with JSON only", so accept a
/// fenced block or a bare array, and fall back to line-splitting.
fn parse_candidates(content: &str, wanted: usize) -> Vec<String> {
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

#[tauri::command]
pub async fn ai_continue(request: ContinueRequest) -> AppResult<Vec<String>> {
    let key = read_api_key()?;
    let wanted = request.candidate_count.clamp(1, 6) as usize;

    if request.model.trim().is_empty() {
        return Err(AppError::msg("No model selected. Choose one in Settings."));
    }

    let body = ChatRequest {
        model: request.model.trim(),
        messages: vec![
            ChatMessage {
                role: "system",
                content: build_system_prompt(&request),
            },
            ChatMessage {
                role: "user",
                content: build_user_prompt(&request),
            },
        ],
        temperature: request.temperature.clamp(0.0, 2.0),
        max_tokens: 600,
    };

    let client = reqwest::Client::new();
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

    let content = parsed
        .choices
        .and_then(|c| c.into_iter().next())
        .and_then(|c| c.message)
        .and_then(|m| m.content)
        .ok_or_else(|| AppError::msg("OpenRouter returned no completion."))?;

    let candidates = parse_candidates(&content, wanted);
    if candidates.is_empty() {
        return Err(AppError::msg("The model returned no usable lines."));
    }
    Ok(candidates.into_iter().take(wanted).collect())
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
