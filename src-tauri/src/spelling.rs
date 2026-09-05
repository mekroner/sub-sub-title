//! Offline spelling and grammar checking, via Harper.
//!
//! Harper is English-only, pure Rust and entirely offline, and it returns
//! character spans with ready-made suggestions — which is exactly what the cue
//! list needs to show a badge and offer a fix. Each cue is linted as its own
//! little document; that is what makes checking incremental and fast, at the
//! cost of rules that need the sentence before (see `DISABLED_RULES`).

use std::collections::HashSet;
use std::sync::Mutex;

use harper_core::linting::{Lint, LintGroup, LintKind, Linter, Suggestion};
use harper_core::spell::FstDictionary;
use harper_core::{Dialect, Document, Span};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};

/// Which lint categories a subtitle editor should report.
///
/// Harper ships far more than spelling: style, readability, redundancy and
/// word-choice advice that is good for prose and wrong for dialogue, which is
/// deliberately colloquial, elliptical and repetitive. Only the categories that
/// describe an actual *error* survive.
const REPORTED_KINDS: &[LintKind] = &[
    LintKind::Spelling,
    LintKind::Typo,
    LintKind::Agreement,
    LintKind::Grammar,
    LintKind::WordOrder,
    LintKind::BoundaryError,
    LintKind::Capitalization,
    LintKind::Punctuation,
    LintKind::Malapropism,
    LintKind::Eggcorn,
    LintKind::Repetition,
];

/// Rules that are right about English and wrong about subtitles.
const DISABLED_RULES: &[&str] = &[
    // A cue routinely continues the sentence the previous cue started, so it
    // legitimately begins in lower case.
    "SentenceCapitalization",
    // "..." and "--" are subtitling conventions, not mistakes to be normalised.
    "UseEllipsisCharacter",
    "EllipsisLength",
    "Dashes",
    // Speech is full of hedges, fillers, contractions and swearing. That is the
    // point of it.
    "AvoidContractions",
    "AvoidCurses",
    "FillerWords",
    "Hedging",
    "BoringWords",
    // Numerals are read faster on screen than spelled-out numbers.
    "SpelledNumbers",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SpellDialect {
    American,
    British,
}

impl From<SpellDialect> for Dialect {
    fn from(value: SpellDialect) -> Self {
        match value {
            SpellDialect::American => Dialect::American,
            SpellDialect::British => Dialect::British,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueText {
    pub id: String,
    pub text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRequest {
    pub cues: Vec<CueText>,
    pub dialect: SpellDialect,
    /// Words the user has told the checker to leave alone.
    #[serde(default)]
    pub ignored: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CueIssue {
    /// UTF-16 offsets, so the frontend can `slice()` without converting.
    pub start: usize,
    pub end: usize,
    /// The offending text, for "Ignore <word>" and for display.
    pub text: String,
    pub message: String,
    /// Harper's lint kind; the frontend colours the badge from it.
    pub kind: String,
    /// Ready-to-apply replacements for the span, best guess first.
    pub replacements: Vec<String>,
    pub source: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CueIssues {
    pub id: String,
    pub issues: Vec<CueIssue>,
}

struct Loaded {
    dialect: SpellDialect,
    group: LintGroup,
}

impl Loaded {
    fn new(dialect: SpellDialect) -> Self {
        let mut group = LintGroup::new_curated(FstDictionary::curated(), dialect.into());
        for rule in DISABLED_RULES {
            group.config.set_rule_enabled(rule, false);
        }
        Self { dialect, group }
    }
}

/// The curated dictionary takes a moment to build, so it is built once and kept.
#[derive(Default)]
pub struct SpellState {
    inner: Mutex<Option<Loaded>>,
}

#[tauri::command]
pub fn check_cues(
    state: State<'_, SpellState>,
    request: CheckRequest,
) -> AppResult<Vec<CueIssues>> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| AppError::msg("The spellchecker is unavailable."))?;

    // Rebuilt only when the dialect changes; the dictionary load dominates.
    if guard.as_ref().is_none_or(|l| l.dialect != request.dialect) {
        *guard = Some(Loaded::new(request.dialect));
    }
    let group = &mut guard.as_mut().expect("just loaded").group;

    let ignored: HashSet<String> = request
        .ignored
        .iter()
        .map(|word| word.trim().to_lowercase())
        .filter(|word| !word.is_empty())
        .collect();

    Ok(request
        .cues
        .iter()
        .map(|cue| CueIssues {
            id: cue.id.clone(),
            issues: check_text(group, &cue.text, &ignored),
        })
        .collect())
}

fn check_text(group: &mut LintGroup, text: &str, ignored: &HashSet<String>) -> Vec<CueIssue> {
    if text.trim().is_empty() {
        return Vec::new();
    }

    let chars: Vec<char> = text.chars().collect();
    let mut lints = group.lint(&Document::new_plain_english_curated(text));
    // Reading order, most important first where two lints start together.
    lints.sort_by_key(|lint| (lint.span.start, lint.priority));

    lints
        .iter()
        .filter_map(|lint| issue_from_lint(lint, &chars, ignored))
        .collect()
}

fn issue_from_lint(lint: &Lint, chars: &[char], ignored: &HashSet<String>) -> Option<CueIssue> {
    if !REPORTED_KINDS.contains(&lint.lint_kind) {
        return None;
    }

    let flagged = lint.get_str(chars);
    // A single flagged word the user has excused. Multi-word spans are left
    // alone: "your going" is not a word anyone adds to a dictionary.
    if !flagged.contains(char::is_whitespace) && ignored.contains(&flagged.to_lowercase()) {
        return None;
    }

    Some(CueIssue {
        start: utf16_offset(chars, lint.span.start),
        end: utf16_offset(chars, lint.span.end),
        text: flagged,
        message: lint.message.clone(),
        kind: lint.lint_kind.to_string_key(),
        replacements: lint
            .suggestions
            .iter()
            .map(|suggestion| replacement_for(suggestion, chars, lint.span))
            .collect(),
        source: "harper",
    })
}

/// The text that should stand where the span currently stands.
///
/// Harper expresses an edit as an operation on the whole buffer; the frontend
/// only ever splices a string into a span, so the two are reconciled here.
/// `replacement_matches_harper` proves the mapping against `Suggestion::apply`.
fn replacement_for(suggestion: &Suggestion, chars: &[char], span: Span<char>) -> String {
    match suggestion {
        Suggestion::ReplaceWith(replacement) => replacement.iter().collect(),
        Suggestion::Remove => String::new(),
        Suggestion::InsertAfter(addition) => {
            let mut out: String = span.get_content(chars).iter().collect();
            out.extend(addition.iter());
            out
        }
    }
}

/// Harper counts characters; JavaScript counts UTF-16 code units. They differ
/// the moment a cue contains an emoji.
fn utf16_offset(chars: &[char], index: usize) -> usize {
    chars[..index.min(chars.len())]
        .iter()
        .map(|c| c.len_utf16())
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issues(text: &str, ignored: &[&str]) -> Vec<CueIssue> {
        let mut group = Loaded::new(SpellDialect::American).group;
        let set: HashSet<String> = ignored.iter().map(|w| w.to_lowercase()).collect();
        check_text(&mut group, text, &set)
    }

    #[test]
    fn finds_a_misspelling_and_offers_the_word() {
        let found = issues("I ate teh cake.", &[]);
        let lint = found
            .iter()
            .find(|i| i.text == "teh")
            .expect("the misspelling should be flagged");
        // Harper separates "didn't know the spelling" (Spelling) from "fingers
        // slipped" (Typo); the UI treats both as a misspelling.
        assert!(matches!(lint.kind.as_str(), "Spelling" | "Typo"), "{}", lint.kind);
        assert!(lint.replacements.iter().any(|r| r == "the"));
    }

    #[test]
    fn splicing_the_replacement_fixes_the_text() {
        let found = issues("I ate teh cake.", &[]);
        let lint = found.iter().find(|i| i.text == "teh").unwrap();
        let mut fixed: String = "I ate teh cake.".to_string();
        fixed.replace_range(lint.start..lint.end, &lint.replacements[0]);
        assert_eq!(fixed, "I ate the cake.");
    }

    #[test]
    fn an_ignored_word_stops_being_reported() {
        assert!(!issues("Kaelen went home.", &[]).is_empty());
        assert!(issues("Kaelen went home.", &["kaelen"]).is_empty());
    }

    #[test]
    fn empty_and_blank_cues_are_skipped() {
        assert!(issues("", &[]).is_empty());
        assert!(issues("   \n  ", &[]).is_empty());
    }

    #[test]
    fn style_advice_is_not_reported() {
        // Dialogue is allowed to be repetitive, hedging and profane; only the
        // error categories in REPORTED_KINDS may reach the UI.
        for issue in issues("I sort of really just wanted to maybe go, you know.", &[]) {
            assert!(
                REPORTED_KINDS
                    .iter()
                    .any(|k| k.to_string_key() == issue.kind),
                "unexpected kind {} for {:?}",
                issue.kind,
                issue.text
            );
        }
    }

    #[test]
    fn a_lower_case_continuation_is_not_flagged() {
        // The previous cue ended mid-sentence; this one carries on.
        assert!(
            issues("and then he left.", &[])
                .iter()
                .all(|i| i.kind != "Capitalization")
        );
    }

    #[test]
    fn offsets_are_utf16_so_javascript_can_slice() {
        let text = "🎬 teh scene";
        let found = issues(text, &[]);
        let lint = found.iter().find(|i| i.text == "teh").unwrap();
        let utf16: Vec<u16> = text.encode_utf16().collect();
        let sliced = String::from_utf16(&utf16[lint.start..lint.end]).unwrap();
        assert_eq!(sliced, "teh");
    }

    #[test]
    fn replacement_matches_harper() {
        // Every replacement string, spliced into its span, must produce exactly
        // what Harper's own `Suggestion::apply` produces over the whole buffer.
        let text = "I ate teh cake and their going home.";
        let chars: Vec<char> = text.chars().collect();
        let mut group = Loaded::new(SpellDialect::American).group;
        let lints = group.lint(&Document::new_plain_english_curated(text));

        for lint in &lints {
            for suggestion in &lint.suggestions {
                let mut applied = chars.clone();
                suggestion.apply(lint.span, &mut applied);
                let expected: String = applied.iter().collect();

                let mut spliced: Vec<char> = chars.clone();
                let replacement: Vec<char> =
                    replacement_for(suggestion, &chars, lint.span).chars().collect();
                spliced.splice(lint.span.start..lint.span.end, replacement);

                assert_eq!(spliced.iter().collect::<String>(), expected);
            }
        }
    }
}
