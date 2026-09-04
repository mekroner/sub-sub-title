/**
 * Hand-rolled SRT parser/serialiser. Deliberately forgiving: files produced by
 * Whisper, Subtitle Edit and assorted web tools disagree about index numbers,
 * blank lines and line endings, so the parser anchors on the `-->` line rather
 * than assuming a rigid block structure.
 */

import type { Cue } from "../types";
import { formatSrtTime, parseTimecode } from "./time";
import { makeId } from "./ids";

const TIMECODE_LINE =
  /^\s*(-?[\d:.,]+)\s*-->\s*(-?[\d:.,]+)(?:\s+.*)?\s*$/;

export interface ParseResult {
  cues: Cue[];
  /** Human-readable notes about anything that was repaired or skipped. */
  warnings: string[];
}

export function parseSrt(input: string): ParseResult {
  const warnings: string[] = [];
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const cues: Cue[] = [];

  let i = 0;
  while (i < lines.length) {
    const match = lines[i].match(TIMECODE_LINE);
    if (!match) {
      i += 1;
      continue;
    }

    const start = parseTimecode(match[1]);
    const end = parseTimecode(match[2]);
    i += 1;

    // Collect text up to a blank line, or up to the index line that precedes
    // the next timecode (some files omit the blank separator entirely).
    const textLines: string[] = [];
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        i += 1;
        break;
      }
      if (TIMECODE_LINE.test(line)) break;
      if (/^\s*\d+\s*$/.test(line) && i + 1 < lines.length && TIMECODE_LINE.test(lines[i + 1])) {
        break;
      }
      textLines.push(line);
      i += 1;
    }

    if (start === null || end === null) {
      warnings.push(`Skipped a cue with an unreadable timecode: "${lines[i - 1] ?? ""}".`);
      continue;
    }

    // A trailing index number belonging to the next block.
    while (textLines.length && /^\s*\d+\s*$/.test(textLines[textLines.length - 1])) {
      textLines.pop();
    }

    const text = textLines.join("\n").trim();
    if (!text) {
      warnings.push(`Skipped an empty cue at ${formatSrtTime(start)}.`);
      continue;
    }

    cues.push({
      id: makeId(),
      start,
      end: end > start ? end : start + 1,
      text,
      speakerId: null,
    });

    if (end <= start) {
      warnings.push(
        `Cue at ${formatSrtTime(start)} ended before it started; gave it a 1s duration.`,
      );
    }
  }

  cues.sort((a, b) => a.start - b.start);
  return { cues, warnings };
}

/** Speaker data is intentionally stripped: `.srt` stays maximally portable. */
export function serializeSrt(cues: Cue[]): string {
  const ordered = [...cues].sort((a, b) => a.start - b.start);
  const blocks = ordered.map((cue, index) => {
    const text = cue.text.replace(/\n{2,}/g, "\n").trim();
    return `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${text}\n`;
  });
  return blocks.join("\n");
}

/**
 * Many transcripts already mark speakers inline as `ALEX: line` or `[Alex] line`.
 * Surfacing those lets the whole file be tagged in one action instead of cue by
 * cue. Detection only; applying the result is an explicit user step.
 */
const PREFIX_PATTERNS = [
  /^\s*([A-Za-zÀ-ÿ0-9 .'-]{1,24}):\s*(.*)$/s,
  /^\s*[[(]\s*([A-Za-zÀ-ÿ0-9 .'-]{1,24})\s*[\])]\s*:?\s*(.*)$/s,
  /^\s*-\s*([A-Za-zÀ-ÿ0-9 .'-]{1,24}):\s*(.*)$/s,
];

export interface DetectedSpeaker {
  name: string;
  count: number;
}

function splitPrefix(text: string): { name: string; rest: string } | null {
  // Only consider the first line; a colon deeper in the cue is normal prose.
  const [firstLine, ...others] = text.split("\n");
  for (const pattern of PREFIX_PATTERNS) {
    const m = firstLine.match(pattern);
    if (!m) continue;
    const name = m[1].trim();
    // Reject things that look like sentences or timecodes rather than names.
    if (!name || name.length < 2 || /\d{2}$/.test(name)) continue;
    if (name.split(/\s+/).length > 3) continue;
    const rest = [m[2], ...others].join("\n").trim();
    return { name, rest };
  }
  return null;
}

export function detectSpeakerPrefixes(cues: Cue[]): DetectedSpeaker[] {
  const counts = new Map<string, number>();
  for (const cue of cues) {
    const found = splitPrefix(cue.text);
    if (!found) continue;
    const key = found.name.toUpperCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .filter((entry) => entry.count >= 2)
    .sort((a, b) => b.count - a.count);
}

/** Removes the `NAME:` prefix from a cue, returning the bare dialogue. */
export function stripSpeakerPrefix(text: string): string {
  return splitPrefix(text)?.rest ?? text;
}

export function speakerNameOf(text: string): string | null {
  return splitPrefix(text)?.name ?? null;
}
