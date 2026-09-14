//! Story beats: a short outline distilled from the whole script, which the Fill
//! dialog sends along as context so generated lines fit the larger story.

use serde::Deserialize;

use crate::ai::{ChatTurn, ContextLine, chat_completion, parse_candidates};
use crate::error::{AppError, AppResult};
use crate::settings::read_api_key;

/// Characters of script sent when asking for beats. Generous enough for a
/// feature-length subtitle track, small enough to leave a model room to answer.
const SCRIPT_BUDGET: usize = 24_000;

/// Marks where a script too long for the budget was cut.
const ELISION: &str = "\n[… the middle of the script is omitted …]\n";

/// Beats are analysis, not invention, so keep the sampling tight.
const BEATS_TEMPERATURE: f32 = 0.2;
const BEATS_MAX_TOKENS: u32 = 900;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatsRequest {
    pub model: String,
    /// The whole script, oldest first.
    pub cues: Vec<ContextLine>,
}

/// Render the script as `SPEAKER: text`, keeping the opening and the ending when
/// it will not fit. A truncated tail would cost the model the one part of the
/// story it most needs to see: how it ends.
fn script_excerpt(cues: &[ContextLine], budget: usize) -> String {
    let lines: Vec<String> = cues
        .iter()
        .filter(|line| !line.text.trim().is_empty())
        .map(|line| {
            let who = if line.speaker.trim().is_empty() {
                "UNKNOWN"
            } else {
                line.speaker.trim()
            };
            format!("{}: {}", who, line.text.replace('\n', " "))
        })
        .collect();

    let whole = lines.join("\n");
    if whole.len() <= budget {
        return whole;
    }

    // Weighted toward the opening, which sets up everything that follows.
    let head_budget = budget * 3 / 5;
    let tail_budget = budget - head_budget;

    let mut head = String::new();
    for line in &lines {
        if head.len() + line.len() + 1 > head_budget {
            break;
        }
        head.push_str(line);
        head.push('\n');
    }

    let mut tail_lines: Vec<&String> = Vec::new();
    let mut tail_len = 0usize;
    for line in lines.iter().rev() {
        if tail_len + line.len() + 1 > tail_budget {
            break;
        }
        tail_len += line.len() + 1;
        tail_lines.push(line);
    }
    tail_lines.reverse();

    let tail = tail_lines
        .iter()
        .map(|l| l.as_str())
        .collect::<Vec<_>>()
        .join("\n");

    format!("{}{}{}", head.trim_end(), ELISION, tail)
}

fn beats_system_prompt() -> String {
    String::from(
        "You are a script editor. You will be given the dialogue of a film, in order. \
         Distil it into the story's core beats.\n\n\
         Rules:\n\
         - Between five and twelve beats, in story order.\n\
         - One short sentence each, describing what happens or changes — not a quotation.\n\
         - Name the characters involved.\n\
         - Cover the whole story, including how it ends.\n\
         - Write in the language the dialogue is in.\n\n\
         Respond with a JSON array of strings, and nothing else. \
         Example format: [\"first beat\", \"second beat\"]",
    )
}

fn beats_user_prompt(req: &BeatsRequest) -> String {
    format!(
        "The dialogue:\n\n{}",
        script_excerpt(&req.cues, SCRIPT_BUDGET)
    )
}

#[tauri::command]
pub async fn ai_story_beats(request: BeatsRequest) -> AppResult<Vec<String>> {
    let key = read_api_key()?;

    if request.cues.iter().all(|line| line.text.trim().is_empty()) {
        return Err(AppError::msg(
            "There is no dialogue yet to draw story beats from.",
        ));
    }

    let messages = [
        ChatTurn {
            role: "system",
            content: beats_system_prompt(),
        },
        ChatTurn {
            role: "user",
            content: beats_user_prompt(&request),
        },
    ];

    let content = chat_completion(
        &key,
        &request.model,
        &messages,
        BEATS_TEMPERATURE,
        BEATS_MAX_TOKENS,
    )
    .await?;

    // A dozen beats is the documented ceiling; allow a little slack over it
    // rather than silently dropping a model's thirteenth.
    let beats = parse_candidates(&content, 16);
    if beats.is_empty() {
        return Err(AppError::msg("The model returned no usable story beats."));
    }
    Ok(beats)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(speaker: &str, text: &str) -> ContextLine {
        ContextLine {
            speaker: speaker.into(),
            text: text.into(),
        }
    }

    #[test]
    fn a_short_script_is_sent_whole() {
        let cues = vec![line("Ben", "One."), line("Anna", "Two.")];
        assert_eq!(script_excerpt(&cues, 1000), "Ben: One.\nAnna: Two.");
    }

    #[test]
    fn a_long_script_keeps_the_opening_and_the_ending() {
        let mut cues = vec![line("Ben", "the very first line")];
        for i in 0..2000 {
            cues.push(line("Filler", &format!("padding line number {i}")));
        }
        cues.push(line("Anna", "the very last line"));

        let got = script_excerpt(&cues, SCRIPT_BUDGET);
        assert!(got.len() <= SCRIPT_BUDGET + ELISION.len());
        assert!(got.contains("the very first line"));
        assert!(got.contains("the very last line"));
        assert!(got.contains("omitted"));
    }
}
