/**
 * Readability measures for caption text. Subtitling convention caps a line at
 * around 42 characters and a cue at two lines; past either, the viewer runs out
 * of time to read before the cue leaves the screen.
 */

export const DEFAULT_MAX_CHARS_PER_LINE = 42;
export const DEFAULT_MAX_LINES = 2;

export interface LineStat {
  text: string;
  length: number;
  /** Longer than the limit. */
  over: boolean;
}

export interface TextStats {
  lines: LineStat[];
  lineCount: number;
  /** Longest line, for a single at-a-glance number. */
  longest: number;
  anyOver: boolean;
  tooManyLines: boolean;
}

/**
 * Per-line character counts. Trailing whitespace does not count — it is
 * invisible on screen — but inner spacing does.
 */
export function lineStats(
  text: string,
  maxChars = DEFAULT_MAX_CHARS_PER_LINE,
  maxLines = DEFAULT_MAX_LINES,
): TextStats {
  const lines = text.split("\n").map((line) => {
    const trimmed = line.replace(/\s+$/, "");
    return { text: trimmed, length: trimmed.length, over: trimmed.length > maxChars };
  });

  return {
    lines,
    lineCount: lines.length,
    longest: lines.reduce((max, l) => Math.max(max, l.length), 0),
    anyOver: lines.some((l) => l.over),
    tooManyLines: lines.length > maxLines,
  };
}

// --- Find and replace -----------------------------------------------------
// Plain substring search, not regex: cue text is dialogue, and a stray `.` or
// `(` in a search box should find that character, not act as a pattern.

export function matchesQuery(text: string, query: string, matchCase: boolean): boolean {
  if (query === "") return false;
  return matchCase
    ? text.includes(query)
    : text.toLowerCase().includes(query.toLowerCase());
}

/** Replace every occurrence, honouring case-insensitive matching. */
export function replaceIn(
  text: string,
  query: string,
  replacement: string,
  matchCase: boolean,
): string {
  if (query === "") return text;
  if (matchCase) return text.split(query).join(replacement);

  const needle = query.toLowerCase();
  const haystack = text.toLowerCase();
  let out = "";
  let cursor = 0;
  for (;;) {
    const at = haystack.indexOf(needle, cursor);
    if (at === -1) break;
    out += text.slice(cursor, at) + replacement;
    cursor = at + needle.length;
  }
  return out + text.slice(cursor);
}

