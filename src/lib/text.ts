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

/**
 * Re-flow `text` into at most `maxLines` lines of roughly `maxChars`. All
 * existing whitespace collapses first, so pasted prose and hard-wrapped script
 * lines both come out as one evenly balanced cue.
 *
 * Lines are balanced rather than filled to the brim: 50 characters over two
 * lines reads better as 25 + 25 than as 42 + 8. Text too long to fit spreads
 * across the lines it is allowed instead of being dropped or truncated — the
 * cue list's own counters flag what is left over.
 */
export function wrapText(
  text: string,
  maxChars = DEFAULT_MAX_CHARS_PER_LINE,
  maxLines = DEFAULT_MAX_LINES,
): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";

  // Spaces count towards the width, so include the gaps between the words.
  const total = words.reduce((n, w) => n + w.length, 0) + words.length - 1;
  const limit = Math.max(1, Math.floor(maxLines));
  const lineCount = Math.min(limit, Math.max(1, Math.ceil(total / Math.max(1, maxChars))));
  const target = Math.ceil(total / lineCount);

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      // A word longer than the target still goes on its own line unbroken;
      // hyphenating dialogue is worse than one over-long line.
      current = word;
      continue;
    }
    const candidate = `${current} ${word}`;
    // The final line takes whatever remains, however long that makes it.
    if (candidate.length > target && lines.length < lineCount - 1) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  lines.push(current);

  return lines.join("\n");
}

// --- Thought markers ------------------------------------------------------
// A thought cue exports wrapped in single asterisks, `*like this*`. The markers
// live only in the exported file: `Cue.text` stays clean, so the line counters,
// the reading-speed maths and the spellchecker all keep seeing real characters.

/**
 * `[^*]` matches newlines too, so a cue wrapped once across a line break is
 * recognised, while `*a* and *b*` is correctly left alone as ordinary text with
 * emphasis in it.
 */
const THOUGHT = /^\*([^*]+)\*$/;

/** Wrap a whole cue once, however many lines it has. */
export function wrapThought(text: string): string {
  const trimmed = text.trim();
  return trimmed === "" ? "" : `*${trimmed}*`;
}

/**
 * The text inside a thought cue's markers, or null when the text is not a
 * single wrapped run.
 *
 * Note a spoken cue that is *entirely* `*sigh*` reads as a thought here. That
 * is inherent to a text-marker convention, and arguably the right call.
 */
export function unwrapThought(text: string): string | null {
  const m = THOUGHT.exec(text.trim());
  if (!m) return null;
  const inner = m[1].trim();
  return inner === "" ? null : inner;
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

