//! The scene-continue feature: several lines of dialogue at once, steered by an
//! outline of the story's core beats.
//!
//! Where `ai.rs` extends the local texture of a conversation one line at a time,
//! this knows what the story is about, so it can write an exchange that moves
//! toward something. The beats themselves are either written by hand or distilled
//! from the whole script by `ai_story_beats`.

use serde::{Deserialize, Serialize};

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

/// Output budget per requested line, plus a fixed allowance for the JSON itself.
const TOKENS_PER_LINE: u32 = 120;
const TOKENS_OVERHEAD: u32 = 200;

/// An exchange needs at least two lines, and past a handful a model starts
/// writing a whole scene instead of a continuation.
const MIN_LINES: u32 = 2;
const MAX_LINES: u32 = 8;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatsRequest {
    pub model: String,
    /// The whole script, oldest first.
    pub cues: Vec<ContextLine>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSpeaker {
    pub name: String,
    pub voice_notes: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneRequest {
    pub model: String,
    pub temperature: f32,
    /// How many lines to write, clamped to `MIN_LINES..=MAX_LINES`.
    pub line_count: u32,
    pub style_notes: String,
    /// The story's core beats, in order. May be empty.
    pub beats: Vec<String>,
    /// Who may speak. The model picks from these by name.
    pub speakers: Vec<SceneSpeaker>,
    /// Preceding dialogue, oldest first.
    pub context: Vec<ContextLine>,
}

/// One line of a generated exchange. The speaker is a name; the frontend maps it
/// back to a speaker id, since the model has no idea what our ids are.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedLine {
    pub speaker: String,
    pub text: String,
}

#[derive(Deserialize)]
struct RawLine {
    #[serde(default)]
    speaker: String,
    #[serde(default)]
    text: String,
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

fn scene_system_prompt(req: &SceneRequest) -> String {
    let count = req.line_count.clamp(MIN_LINES, MAX_LINES);
    let mut s = format!(
        "You are helping write dialogue for a subtitled video. Given the recent lines of a \
         scene, write the next {count} lines as the exchange continues.\n\n\
         Rules:\n\
         - Write only what each speaker says. No speaker name prefix inside the line, no \
         quotation marks, no stage directions, no narration.\n\
         - Keep every line to subtitle length: at most about 15 words, one or two short \
         sentences.\n\
         - Match the language, register, and tone of the surrounding lines.\n\
         - Let the speakers take turns as the exchange calls for it. The same speaker may \
         take two lines in a row, but do not write a monologue.\n\
         - Continue the scene naturally. Do not summarise or conclude it.\n"
    );

    if !req.style_notes.trim().is_empty() {
        s.push_str(&format!(
            "\nOverall style guidance: {}\n",
            req.style_notes.trim()
        ));
    }

    s.push_str(&format!(
        "\nRespond with a JSON array of exactly {count} objects, and nothing else. Each object \
         is {{\"speaker\": \"<one of the named speakers>\", \"text\": \"<what they say>\"}}. \
         Example format: [{{\"speaker\": \"Anna\", \"text\": \"first line\"}}]"
    ));
    s
}

fn scene_user_prompt(req: &SceneRequest) -> String {
    let mut s = String::new();

    if !req.speakers.is_empty() {
        s.push_str("The speakers in this scene:\n\n");
        for speaker in &req.speakers {
            s.push_str(&format!("- {}", speaker.name.trim()));
            if !speaker.voice_notes.trim().is_empty() {
                s.push_str(&format!(" — {}", speaker.voice_notes.trim()));
            }
            s.push('\n');
        }
        s.push('\n');
    }

    // The mode has to work before any beats exist, so this section is optional.
    let beats: Vec<&str> = req
        .beats
        .iter()
        .map(|beat| beat.trim())
        .filter(|beat| !beat.is_empty())
        .collect();
    if !beats.is_empty() {
        s.push_str(
            "The core beats of the whole story, in order. The lines you write must fit this \
             story and carry it toward the beats that have not happened yet:\n\n",
        );
        for (i, beat) in beats.iter().enumerate() {
            s.push_str(&format!("{}. {}\n", i + 1, beat));
        }
        s.push('\n');
    }

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

    s.push_str(&format!(
        "\nWrite the next {} lines.",
        req.line_count.clamp(MIN_LINES, MAX_LINES)
    ));
    s
}

/// Take the first `[` to the last `]`, so a fenced block or a chatty preamble
/// does not sink the request. Mirrors `ai::parse_candidates`.
fn parse_lines(content: &str, wanted: usize) -> Vec<GeneratedLine> {
    let Some(start) = content.find('[') else {
        return Vec::new();
    };
    let Some(end) = content.rfind(']') else {
        return Vec::new();
    };
    if end < start {
        return Vec::new();
    }

    let raw: Vec<RawLine> = serde_json::from_str(&content[start..=end]).unwrap_or_default();

    raw.into_iter()
        .filter(|line| !line.text.trim().is_empty())
        .map(|line| GeneratedLine {
            speaker: line.speaker.trim().to_string(),
            text: line.text.trim().to_string(),
        })
        .take(wanted.max(1))
        .collect()
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

#[tauri::command]
pub async fn ai_continue_scene(request: SceneRequest) -> AppResult<Vec<GeneratedLine>> {
    let key = read_api_key()?;
    let wanted = request.line_count.clamp(MIN_LINES, MAX_LINES);

    if request.speakers.is_empty() {
        return Err(AppError::msg(
            "Add at least one speaker before writing an exchange.",
        ));
    }

    let messages = [
        ChatTurn {
            role: "system",
            content: scene_system_prompt(&request),
        },
        ChatTurn {
            role: "user",
            content: scene_user_prompt(&request),
        },
    ];

    let content = chat_completion(
        &key,
        &request.model,
        &messages,
        request.temperature,
        TOKENS_PER_LINE * wanted + TOKENS_OVERHEAD,
    )
    .await?;

    let lines = parse_lines(&content, wanted as usize);
    if lines.is_empty() {
        return Err(AppError::msg("The model returned no usable lines."));
    }
    Ok(lines)
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

    fn scene_req(beats: Vec<String>) -> SceneRequest {
        SceneRequest {
            model: "test/model".into(),
            temperature: 0.9,
            line_count: 4,
            style_notes: String::new(),
            beats,
            speakers: vec![SceneSpeaker {
                name: "Anna".into(),
                voice_notes: "Clipped sentences.".into(),
            }],
            context: vec![line("Ben", "Where did the money go?")],
        }
    }

    #[test]
    fn parses_a_bare_json_array_of_lines() {
        let got = parse_lines(r#"[{"speaker":"Anna","text":"It's gone."}]"#, 4);
        assert_eq!(
            got,
            vec![GeneratedLine {
                speaker: "Anna".into(),
                text: "It's gone.".into()
            }]
        );
    }

    #[test]
    fn parses_a_fenced_block_and_drops_empty_lines() {
        let got = parse_lines(
            "```json\n[{\"speaker\":\"Anna\",\"text\":\"One.\"},{\"speaker\":\"Ben\",\"text\":\"  \"}]\n```",
            4,
        );
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].text, "One.");
    }

    #[test]
    fn keeps_no_more_lines_than_asked_for() {
        let content =
            r#"[{"speaker":"A","text":"1"},{"speaker":"B","text":"2"},{"speaker":"A","text":"3"}]"#;
        assert_eq!(parse_lines(content, 2).len(), 2);
    }

    #[test]
    fn a_reply_that_is_not_a_list_yields_nothing() {
        assert!(parse_lines("I cannot help with that.", 4).is_empty());
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

    #[test]
    fn the_scene_prompt_lists_the_beats() {
        let got = scene_user_prompt(&scene_req(vec![
            "Anna suspects Ben".into(),
            "The money is gone".into(),
        ]));
        assert!(got.contains("1. Anna suspects Ben"));
        assert!(got.contains("2. The money is gone"));
    }

    #[test]
    fn the_scene_prompt_omits_the_beats_section_when_there_are_none() {
        let got = scene_user_prompt(&scene_req(vec![String::new(), "   ".into()]));
        assert!(!got.contains("core beats"));
        assert!(got.contains("Recent dialogue"));
    }

    #[test]
    fn the_scene_prompt_names_the_speakers_and_their_voices() {
        let got = scene_user_prompt(&scene_req(Vec::new()));
        assert!(got.contains("- Anna — Clipped sentences."));
    }

    #[test]
    fn the_line_count_is_clamped_in_the_prompt() {
        let mut req = scene_req(Vec::new());
        req.line_count = 99;
        assert!(scene_system_prompt(&req).contains("the next 8 lines"));
        assert!(scene_user_prompt(&req).contains("Write the next 8 lines."));
    }
}
