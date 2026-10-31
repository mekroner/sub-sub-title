//! Suggesting a voice script for one cue: its line rewritten for the voice
//! engine, with Chatterbox Turbo's delivery and sound tags placed to follow a
//! free-text direction. The subtitle itself is never touched; the suggestion
//! only ever lands in the cue's voice script, where the writer can edit it.

use serde::Deserialize;

use crate::ai::{ChatTurn, ContextLine, chat_completion};
use crate::error::{AppError, AppResult};
use crate::settings::read_api_key;

/// Placing tags is closer to editing than to writing; keep it steady.
const DIRECT_TEMPERATURE: f32 = 0.4;
const DIRECT_MAX_TOKENS: u32 = 300;

/// Turbo's own tags — the added tokens in its tokenizer. Anything else in
/// square brackets would be read aloud, so nothing else may be suggested.
const SOUND_TAGS: &str = "[laugh] [chuckle] [sigh] [gasp] [groan] [cough] [sniff] [clear throat] [shush]";
const DELIVERY_TAGS: &str = "[whispering] [crying] [angry] [fear] [happy] [surprised] [sarcastic] [dramatic] [narration]";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectRequest {
    pub model: String,
    pub speaker: String,
    /// How the speaker talks, from the Speakers panel.
    #[serde(default)]
    pub voice_notes: String,
    /// The cue's subtitle text.
    pub text: String,
    /// The current voice script, if one has been written.
    #[serde(default)]
    pub spoken: String,
    pub direction: String,
    /// "turbo" places tags; "standard" cannot speak them.
    pub engine: String,
    #[serde(default)]
    pub before: Vec<ContextLine>,
    #[serde(default)]
    pub after: Vec<ContextLine>,
}

fn system_prompt(engine: &str) -> String {
    let tags = if engine == "turbo" {
        format!(
            "You may use only these tags, exactly as written:\n\
             Sounds, placed where they happen: {SOUND_TAGS}\n\
             Delivery, placed at the start of the stretch they colour: {DELIVERY_TAGS}\n\
             Use as few as the direction needs; most lines want one or two, some none."
        )
    } else {
        "This voice engine cannot perform tags, so write none. Convey the direction \
         through punctuation alone: commas and ellipses for hesitation, dashes for \
         breaks, an exclamation mark for force."
            .to_string()
    };
    format!(
        "You prepare lines for a text-to-speech voice actor in a film's voiceover.\n\
         Given a line of dialogue and a director's note, write the line as it should be \
         performed.\n\n\
         Keep the words. You may add a hesitation, a repeated word or a trailing-off where \
         the direction calls for it, and adjust punctuation to shape the delivery, but do \
         not reword, translate, summarise or censor the line.\n\n\
         {tags}\n\n\
         Reply with the performed line only: no quotes, no speaker name, no commentary."
    )
}

fn user_prompt(r: &DirectRequest) -> String {
    let lines = |list: &[ContextLine]| {
        list.iter()
            .map(|l| format!("{}: {}", l.speaker, l.text))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let mut prompt = String::new();
    if !r.before.is_empty() {
        prompt.push_str(&format!("Dialogue before:\n{}\n\n", lines(&r.before)));
    }
    prompt.push_str(&format!("Speaker: {}\n", r.speaker));
    if !r.voice_notes.trim().is_empty() {
        prompt.push_str(&format!("How they talk: {}\n", r.voice_notes.trim()));
    }
    prompt.push_str(&format!("Line: {}\n", r.text.trim()));
    if !r.spoken.trim().is_empty() && r.spoken.trim() != r.text.trim() {
        prompt.push_str(&format!("Current performance script: {}\n", r.spoken.trim()));
    }
    prompt.push_str(&format!("Direction: {}\n", r.direction.trim()));
    if !r.after.is_empty() {
        prompt.push_str(&format!("\nDialogue after:\n{}\n", lines(&r.after)));
    }
    prompt
}

/// Removes what models wrap a one-line answer in despite being asked not to.
fn clean(reply: &str, speaker: &str) -> String {
    let mut line = reply.trim().lines().next().unwrap_or("").trim().to_string();
    let prefix = format!("{speaker}:");
    if !speaker.is_empty() && line.starts_with(&prefix) {
        line = line[prefix.len()..].trim().to_string();
    }
    for (open, close) in [('"', '"'), ('“', '”'), ('\'', '\'')] {
        if line.len() >= 2 && line.starts_with(open) && line.ends_with(close) {
            line = line[open.len_utf8()..line.len() - close.len_utf8()].trim().to_string();
        }
    }
    line
}

#[tauri::command]
pub async fn ai_direct_line(request: DirectRequest) -> AppResult<String> {
    let key = read_api_key()?;
    if request.text.trim().is_empty() && request.spoken.trim().is_empty() {
        return Err(AppError::msg("This cue has no line to direct."));
    }
    let messages = [
        ChatTurn {
            role: "system",
            content: system_prompt(&request.engine),
        },
        ChatTurn {
            role: "user",
            content: user_prompt(&request),
        },
    ];
    let reply = chat_completion(
        &key,
        &request.model,
        &messages,
        DIRECT_TEMPERATURE,
        DIRECT_MAX_TOKENS,
    )
    .await?;
    let line = clean(&reply, &request.speaker);
    if line.is_empty() {
        return Err(AppError::msg("The model returned no line."));
    }
    Ok(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_quotes_and_speaker_names() {
        assert_eq!(clean("\"[sigh] Fine.\"", "Ada"), "[sigh] Fine.");
        assert_eq!(clean("Ada: [laugh] No.\nExplanation…", "Ada"), "[laugh] No.");
        assert_eq!(clean("“Oh.”", ""), "Oh.");
    }

    #[test]
    fn offers_tags_only_to_turbo() {
        assert!(system_prompt("turbo").contains("[whispering]"));
        assert!(!system_prompt("standard").contains("[whispering]"));
    }

    #[test]
    fn includes_context_and_the_existing_script() {
        let request = DirectRequest {
            model: "m".into(),
            speaker: "Ada".into(),
            voice_notes: "clipped".into(),
            text: "Fine.".into(),
            spoken: "[sigh] Fine.".into(),
            direction: "tired".into(),
            engine: "turbo".into(),
            before: vec![ContextLine { speaker: "Ben".into(), text: "You okay?".into() }],
            after: vec![],
        };
        let prompt = user_prompt(&request);
        assert!(prompt.contains("Ben: You okay?"));
        assert!(prompt.contains("How they talk: clipped"));
        assert!(prompt.contains("Current performance script: [sigh] Fine."));
        assert!(prompt.contains("Direction: tired"));
    }
}
