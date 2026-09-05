//! The AI proofreading pass: a second opinion on cue text, over OpenRouter.
//!
//! Harper (see `spelling.rs`) reads one cue at a time and knows nothing about
//! the scene. This pass sends whole batches of cues, so it can catch the errors
//! that only make sense in context — a homophone that is a real word, an
//! agreement error spanning a line break, a name spelled two ways.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::ai::{ChatTurn, chat_completion};
use crate::error::{AppError, AppResult};
use crate::settings::read_api_key;

/// Cues per request. Large enough to be worth the round trip, small enough that
/// a model does not lose track of the numbering or blow its output budget.
const BATCH_SIZE: usize = 20;

/// Output tokens per batch. Corrections are about as long as the input.
const MAX_TOKENS: u32 = 1500;

/// A rewrite far longer than the original means the model started explaining
/// itself, or merged neighbouring lines. Refuse it rather than mangle the cue.
const LENGTH_GUARD: usize = 3;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofreadCue {
    pub id: String,
    pub text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofreadRequest {
    pub model: String,
    pub cues: Vec<ProofreadCue>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Correction {
    /// The cue this applies to.
    pub id: String,
    /// The whole cue text, rewritten.
    pub corrected: String,
    /// One short phrase saying what was wrong.
    pub reason: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProofreadProgress {
    fraction: f64,
    done: usize,
    total: usize,
}

#[derive(Default)]
pub struct ProofreadState {
    cancelled: AtomicBool,
}

/// There is one proofread at a time, so a bare flag is enough. Unlike a render
/// there is no child process to kill: the flag is read between batches.
#[tauri::command]
pub fn cancel_proofread(state: State<'_, ProofreadState>) {
    state.cancelled.store(true, Ordering::SeqCst);
}

fn system_prompt() -> String {
    String::from(
        "You are proofreading the subtitles of a film. Each item is one on-screen \
         caption of dialogue.\n\n\
         Correct only:\n\
         - spelling mistakes\n\
         - grammatical errors\n\
         - punctuation and capitalisation errors\n\n\
         Never:\n\
         - rephrase, shorten, improve or translate a line\n\
         - merge, split or reorder lines\n\
         - change the existing line breaks inside a caption\n\
         - \"fix\" deliberate slang, dialect, profanity, sentence fragments, or \
         interrupted and trailing speech\n\n\
         A caption often continues a sentence from the caption before it, so a line \
         may correctly begin in lower case and end without a full stop.\n\n\
         Reply with a JSON array and nothing else. Include an object only for captions \
         that need a correction; omit the rest. Each object is \
         {\"n\": <the caption's number>, \"corrected\": \"<the full corrected text>\", \
         \"reason\": \"<at most six words>\"}. \
         If nothing needs correcting, reply with [].",
    )
}

fn user_prompt(batch: &[ProofreadCue]) -> String {
    // JSON in, JSON out: it escapes the line breaks inside a caption, which are
    // significant and must survive the round trip intact.
    let numbered: Vec<serde_json::Value> = batch
        .iter()
        .enumerate()
        .map(|(i, cue)| serde_json::json!({ "n": i + 1, "text": cue.text }))
        .collect();

    format!(
        "Captions:\n{}",
        serde_json::to_string_pretty(&numbered).unwrap_or_default()
    )
}

#[derive(Deserialize)]
struct RawCorrection {
    n: usize,
    corrected: String,
    #[serde(default)]
    reason: String,
}

/// Take the first `[` to the last `]`, so a fenced block or a chatty preamble
/// does not sink the batch. Mirrors `ai::parse_candidates`.
fn parse_corrections(content: &str, batch: &[ProofreadCue]) -> Vec<Correction> {
    let Some(start) = content.find('[') else {
        return Vec::new();
    };
    let Some(end) = content.rfind(']') else {
        return Vec::new();
    };
    if end < start {
        return Vec::new();
    }

    let raw: Vec<RawCorrection> = serde_json::from_str(&content[start..=end]).unwrap_or_default();

    raw.into_iter()
        .filter_map(|item| {
            let cue = batch.get(item.n.checked_sub(1)?)?;
            let corrected = item.corrected;

            // Nothing to do, or the model wandered off.
            if corrected.trim().is_empty()
                || corrected == cue.text
                || corrected.trim() == cue.text.trim()
                || corrected.chars().count() > cue.text.chars().count() * LENGTH_GUARD + 20
            {
                return None;
            }

            Some(Correction {
                id: cue.id.clone(),
                corrected,
                reason: item.reason,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn ai_proofread(
    app: AppHandle,
    state: State<'_, ProofreadState>,
    request: ProofreadRequest,
) -> AppResult<Vec<Correction>> {
    let key = read_api_key()?;
    let cues: Vec<ProofreadCue> = request
        .cues
        .into_iter()
        .filter(|cue| !cue.text.trim().is_empty())
        .collect();

    if cues.is_empty() {
        return Err(AppError::msg("There is no cue text to proofread."));
    }

    state.cancelled.store(false, Ordering::SeqCst);
    let total = cues.len();
    let mut corrections = Vec::new();
    let mut done = 0usize;

    let _ = app.emit(
        "proofread-progress",
        ProofreadProgress {
            fraction: 0.0,
            done,
            total,
        },
    );

    for batch in cues.chunks(BATCH_SIZE) {
        if state.cancelled.swap(false, Ordering::SeqCst) {
            return Err(AppError::msg("The proofread was cancelled."));
        }

        let messages = [
            ChatTurn {
                role: "system",
                content: system_prompt(),
            },
            ChatTurn {
                role: "user",
                content: user_prompt(batch),
            },
        ];

        // Deterministic: proofreading is not a creative task.
        let content = chat_completion(&key, &request.model, &messages, 0.0, MAX_TOKENS).await?;
        corrections.extend(parse_corrections(&content, batch));

        done += batch.len();
        let _ = app.emit(
            "proofread-progress",
            ProofreadProgress {
                fraction: done as f64 / total as f64,
                done,
                total,
            },
        );
    }

    Ok(corrections)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batch() -> Vec<ProofreadCue> {
        vec![
            ProofreadCue {
                id: "a".into(),
                text: "I ate teh cake.".into(),
            },
            ProofreadCue {
                id: "b".into(),
                text: "Their going home.".into(),
            },
        ]
    }

    #[test]
    fn maps_numbers_back_to_cue_ids() {
        let out = parse_corrections(
            r#"[{"n": 2, "corrected": "They're going home.", "reason": "wrong homophone"}]"#,
            &batch(),
        );
        assert_eq!(
            out,
            vec![Correction {
                id: "b".into(),
                corrected: "They're going home.".into(),
                reason: "wrong homophone".into(),
            }]
        );
    }

    #[test]
    fn survives_a_fenced_block_and_a_preamble() {
        let out = parse_corrections(
            "Sure! Here are the corrections:\n```json\n[{\"n\": 1, \"corrected\": \"I ate the cake.\"}]\n```",
            &batch(),
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "a");
        assert_eq!(out[0].reason, "");
    }

    #[test]
    fn drops_numbers_outside_the_batch() {
        let out = parse_corrections(
            r#"[{"n": 0, "corrected": "x"}, {"n": 99, "corrected": "y"}]"#,
            &batch(),
        );
        assert!(out.is_empty());
    }

    #[test]
    fn drops_corrections_that_change_nothing() {
        let out = parse_corrections(
            r#"[{"n": 1, "corrected": "I ate teh cake."}, {"n": 2, "corrected": "  Their going home. "}]"#,
            &batch(),
        );
        assert!(out.is_empty());
    }

    #[test]
    fn refuses_a_rewrite_that_ran_away() {
        let rambling = "Here is what I think you meant, ".repeat(10);
        let out = parse_corrections(
            &serde_json::json!([{ "n": 1, "corrected": rambling }]).to_string(),
            &batch(),
        );
        assert!(out.is_empty());
    }

    #[test]
    fn a_missing_array_is_not_an_error() {
        assert!(parse_corrections("I could not find any mistakes.", &batch()).is_empty());
    }

    #[test]
    fn line_breaks_survive_the_prompt() {
        let cues = vec![ProofreadCue {
            id: "a".into(),
            text: "First line\nsecond line".into(),
        }];
        assert!(user_prompt(&cues).contains("First line\\nsecond line"));
    }
}
