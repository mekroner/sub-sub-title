/** Pure helpers for spelling and proofreading issues. */

import type { CueIssue } from "../types";

export type IssueSeverity = "spelling" | "grammar" | "suggestion";

/**
 * How loudly to flag an issue. Harper separates "didn't know the spelling"
 * from "fingers slipped"; both are a misspelling as far as the editor cares.
 */
export function issueSeverity(issue: CueIssue): IssueSeverity {
  if (issue.source === "ai") return "suggestion";
  return issue.kind === "Spelling" || issue.kind === "Typo" ? "spelling" : "grammar";
}

/** Splice a replacement into the span it belongs to. */
export function applyReplacement(
  text: string,
  issue: CueIssue,
  replacement: string,
): string {
  // Offsets come from the checker as UTF-16, matching JS string indices, but a
  // stale issue could still point past the end of an edited cue.
  const start = Math.min(Math.max(0, issue.start), text.length);
  const end = Math.min(Math.max(start, issue.end), text.length);
  return text.slice(0, start) + replacement + text.slice(end);
}

/** Menu label for applying one replacement. */
export function replacementLabel(issue: CueIssue, replacement: string): string {
  if (issue.source === "ai") return "Apply correction";
  if (replacement === "") return `Remove “${issue.text}”`;
  return `Replace “${issue.text}” with “${replacement}”`;
}

/** Whether "Ignore this word" makes sense for an issue. */
export function isSingleWord(issue: CueIssue): boolean {
  const word = issue.text.trim();
  return word.length > 0 && !/\s/.test(word);
}

/** One line summarising a cue's issues, for the badge's tooltip. */
export function issueTooltip(issues: CueIssue[]): string {
  return issues.map((issue) => `${issue.text}: ${issue.message}`).join("\n");
}
