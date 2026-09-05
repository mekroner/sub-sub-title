/**
 * Hand-rolled SRT parser/serialiser. Deliberately forgiving: files produced by
 * Whisper, Subtitle Edit and assorted web tools disagree about index numbers,
 * blank lines and line endings, so the parser anchors on the `-->` line rather
 * than assuming a rigid block structure.
 */

import type { Cue, Speaker } from "../types";
import { formatSrtTime, parseTimecode } from "./time";
import { makeId } from "./ids";
import { DEFAULT_MIN_GAP, MIN_CUE_DURATION } from "./cues";

const TIMECODE_LINE =
  /^\s*(-?[\d:.,]+)\s*-->\s*(-?[\d:.,]+)(?:\s+.*)?\s*$/;

/**
 * A colour group found in the file's `<font color=…>` tags. Deliberately not a
 * `Speaker`: grouping by colour is a property of the file, but *naming* needs
 * the project's existing speakers, so that happens in `mergeImportedSpeakers`.
 */
export interface ImportedSpeaker {
  /** Provisional id, referenced by the returned cues' `speakerId`. */
  id: string;
  /** Normalised `#rrggbb`, taken verbatim from the file, not from the palette. */
  color: string;
  /** How many cues carry this colour. */
  count: number;
}

export interface ParseResult {
  cues: Cue[];
  /** Colour groups found in `<font color=…>`, in order of first appearance. */
  speakers: ImportedSpeaker[];
  /**
   * How many source blocks were divided because they held more than one speaker
   * colour. Counted apart from `warnings`: nothing was broken, but the cue count
   * and the timings no longer match the file, which the user should hear about.
   */
  split: number;
  /** Human-readable notes about anything that was repaired or skipped. */
  warnings: string[];
}

/** Any `<font …>` or `</font>`, however sloppily written. */
const FONT_TAG = /<\s*\/?\s*font\b[^>]*>/gi;

/** Opening tags only, capturing the attribute run. */
const FONT_OPEN = /<\s*font\b([^>]*)>/gi;

/** `color="#fff"`, `color='#fff'`, `color=#fff`, `COLOR = red`. */
const COLOR_ATTR = /\bcolor\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/i;

/**
 * The full CSS named-colour list. Hand-written subtitles reach for whatever name
 * the author knew — `cornflowerblue`, `pink` — so carrying only the HTML-4 set
 * silently drops speakers. The whole table costs a couple of kilobytes.
 */
const NAMED_COLORS: Record<string, string> = {
  aliceblue: "#f0f8ff", antiquewhite: "#faebd7", aqua: "#00ffff",
  aquamarine: "#7fffd4", azure: "#f0ffff", beige: "#f5f5dc",
  bisque: "#ffe4c4", black: "#000000", blanchedalmond: "#ffebcd",
  blue: "#0000ff", blueviolet: "#8a2be2", brown: "#a52a2a",
  burlywood: "#deb887", cadetblue: "#5f9ea0", chartreuse: "#7fff00",
  chocolate: "#d2691e", coral: "#ff7f50", cornflowerblue: "#6495ed",
  cornsilk: "#fff8dc", crimson: "#dc143c", cyan: "#00ffff",
  darkblue: "#00008b", darkcyan: "#008b8b", darkgoldenrod: "#b8860b",
  darkgray: "#a9a9a9", darkgreen: "#006400", darkgrey: "#a9a9a9",
  darkkhaki: "#bdb76b", darkmagenta: "#8b008b", darkolivegreen: "#556b2f",
  darkorange: "#ff8c00", darkorchid: "#9932cc", darkred: "#8b0000",
  darksalmon: "#e9967a", darkseagreen: "#8fbc8f", darkslateblue: "#483d8b",
  darkslategray: "#2f4f4f", darkslategrey: "#2f4f4f", darkturquoise: "#00ced1",
  darkviolet: "#9400d3", deeppink: "#ff1493", deepskyblue: "#00bfff",
  dimgray: "#696969", dimgrey: "#696969", dodgerblue: "#1e90ff",
  firebrick: "#b22222", floralwhite: "#fffaf0", forestgreen: "#228b22",
  fuchsia: "#ff00ff", gainsboro: "#dcdcdc", ghostwhite: "#f8f8ff",
  gold: "#ffd700", goldenrod: "#daa520", gray: "#808080",
  green: "#008000", greenyellow: "#adff2f", grey: "#808080",
  honeydew: "#f0fff0", hotpink: "#ff69b4", indianred: "#cd5c5c",
  indigo: "#4b0082", ivory: "#fffff0", khaki: "#f0e68c",
  lavender: "#e6e6fa", lavenderblush: "#fff0f5", lawngreen: "#7cfc00",
  lemonchiffon: "#fffacd", lightblue: "#add8e6", lightcoral: "#f08080",
  lightcyan: "#e0ffff", lightgoldenrodyellow: "#fafad2", lightgray: "#d3d3d3",
  lightgreen: "#90ee90", lightgrey: "#d3d3d3", lightpink: "#ffb6c1",
  lightsalmon: "#ffa07a", lightseagreen: "#20b2aa", lightskyblue: "#87cefa",
  lightslategray: "#778899", lightslategrey: "#778899", lightsteelblue: "#b0c4de",
  lightyellow: "#ffffe0", lime: "#00ff00", limegreen: "#32cd32",
  linen: "#faf0e6", magenta: "#ff00ff", maroon: "#800000",
  mediumaquamarine: "#66cdaa", mediumblue: "#0000cd", mediumorchid: "#ba55d3",
  mediumpurple: "#9370db", mediumseagreen: "#3cb371", mediumslateblue: "#7b68ee",
  mediumspringgreen: "#00fa9a", mediumturquoise: "#48d1cc",
  mediumvioletred: "#c71585", midnightblue: "#191970", mintcream: "#f5fffa",
  mistyrose: "#ffe4e1", moccasin: "#ffe4b5", navajowhite: "#ffdead",
  navy: "#000080", oldlace: "#fdf5e6", olive: "#808000",
  olivedrab: "#6b8e23", orange: "#ffa500", orangered: "#ff4500",
  orchid: "#da70d6", palegoldenrod: "#eee8aa", palegreen: "#98fb98",
  paleturquoise: "#afeeee", palevioletred: "#db7093", papayawhip: "#ffefd5",
  peachpuff: "#ffdab9", peru: "#cd853f", pink: "#ffc0cb",
  plum: "#dda0dd", powderblue: "#b0e0e6", purple: "#800080",
  rebeccapurple: "#663399", red: "#ff0000", rosybrown: "#bc8f8f",
  royalblue: "#4169e1", saddlebrown: "#8b4513", salmon: "#fa8072",
  sandybrown: "#f4a460", seagreen: "#2e8b57", seashell: "#fff5ee",
  sienna: "#a0522d", silver: "#c0c0c0", skyblue: "#87ceeb",
  slateblue: "#6a5acd", slategray: "#708090", slategrey: "#708090",
  snow: "#fffafa", springgreen: "#00ff7f", steelblue: "#4682b4",
  tan: "#d2b48c", teal: "#008080", thistle: "#d8bfd8",
  tomato: "#ff6347", turquoise: "#40e0d0", violet: "#ee82ee",
  wheat: "#f5deb3", white: "#ffffff", whitesmoke: "#f5f5f5",
  yellow: "#ffff00", yellowgreen: "#9acd32",
};

/** `#RGB`, `#RRGGBB`, a bare `RRGGBB`, or a name above, as `#rrggbb`. */
export function normalizeFontColor(value: string): string | null {
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  if (NAMED_COLORS[raw]) return NAMED_COLORS[raw];
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(raw);
  if (!m) return null;
  const hex = m[1];
  return hex.length === 3
    ? `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
    : `#${hex}`;
}

/** A run of text under one speaker's colour. */
interface ColorSegment {
  color: string | null;
  text: string;
}

/**
 * Strips any leftover font tags and trims the run. `trimLines` re-trims each
 * line, for blocks that carried markup: cutting `<font color="pink"> Hey.` at
 * the tag leaves the line indented by the space that followed it. It is decided
 * for the whole block, not per run — a run sliced after its opening tag no
 * longer contains one, so it cannot tell on its own that it was cut.
 */
function cleanSegment(raw: string, trimLines: boolean): string {
  const stripped = stripFontTags(raw);
  return (
    trimLines
      ? stripped.split("\n").map((line) => line.trim()).join("\n")
      : stripped
  ).trim();
}

/**
 * Cuts a cue into runs at each `<font color=…>` that opens a *different* colour.
 *
 * Two people sharing one subtitle block is a normal SubRip convention, but a
 * `Cue` holds a single `speakerId` and the preview and `.ass` export can paint
 * only one colour per cue — so a block like this has to become two cues:
 *
 *     <font color="cornflowerBlue">Hey dude.
 *     <font color="pink"> Hey.
 *
 * Text before the first coloured tag joins the run that follows it, so partially
 * wrapped prose (`Hello <font color="#f00">world</font>`) stays one cue. Tags
 * carrying no usable colour — `<font face="Arial">`, an unknown name — are
 * skipped rather than ending the scan, and an unreadable colour is dropped
 * silently: letting it through would break every `#rrggbb` consumer downstream.
 */
function splitByColor(raw: string): ColorSegment[] {
  // A file with no markup keeps whatever line spacing its author chose.
  const hadTags = stripFontTags(raw) !== raw;
  const opens: { start: number; end: number; color: string }[] = [];
  FONT_OPEN.lastIndex = 0; // The /g regex is module-level and keeps state.
  for (let m = FONT_OPEN.exec(raw); m; m = FONT_OPEN.exec(raw)) {
    const attr = COLOR_ATTR.exec(m[1]);
    if (!attr) continue;
    const color = normalizeFontColor(attr[1] ?? attr[2] ?? attr[3] ?? "");
    if (color) opens.push({ start: m.index, end: m.index + m[0].length, color });
  }

  if (opens.length === 0) {
    const text = cleanSegment(raw, hadTags);
    return text ? [{ color: null, text }] : [];
  }

  // Whatever precedes the first tag belongs to the run it introduces.
  const runs: ColorSegment[] = [];
  let lead = raw.slice(0, opens[0].start);
  for (let i = 0; i < opens.length; i += 1) {
    const body = raw.slice(opens[i].end, opens[i + 1]?.start ?? raw.length);
    const previous = runs[runs.length - 1];
    // A colour re-opened on every line is still one speaker talking.
    if (previous && previous.color === opens[i].color) {
      previous.text += body;
      continue;
    }
    runs.push({ color: opens[i].color, text: lead + body });
    lead = "";
  }

  const segments = runs
    .map((run) => ({ color: run.color, text: cleanSegment(run.text, hadTags) }))
    .filter((run) => run.text !== "");

  // One speaker: keep the cue whole, so a partial wrap does not fragment prose.
  const colors = new Set(segments.map((s) => s.color));
  if (colors.size <= 1) {
    const text = segments.map((s) => s.text).join("\n");
    return text ? [{ color: segments[0]?.color ?? null, text }] : [];
  }
  return segments;
}

/** Removes every `<font>`/`</font>`, matched or not, leaving `<i>`/`<b>`/`<u>`. */
export function stripFontTags(text: string): string {
  return text.replace(FONT_TAG, "");
}

export interface ParseOptions {
  /**
   * Enforced silence left between the pieces of a block split across speakers,
   * so the import does not hand back cues its own overlap check rejects.
   */
  minGap?: number;
}

export function parseSrt(input: string, options: ParseOptions = {}): ParseResult {
  const minGap = Math.max(0, options.minGap ?? DEFAULT_MIN_GAP);
  const warnings: string[] = [];
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const cues: Cue[] = [];
  const speakers: ImportedSpeaker[] = [];

  let split = 0;
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

    // Read the colour before stripping, so a cue that is nothing but font tags
    // still lands in the existing empty-cue path rather than inventing a speaker.
    const rawText = textLines.join("\n").trim();
    let segments = splitByColor(rawText);
    if (segments.length === 0) {
      warnings.push(`Skipped an empty cue at ${formatSrtTime(start)}.`);
      continue;
    }

    const safeEnd = end > start ? end : start + 1;
    // Leave the editor's enforced silence between the pieces, or the import
    // would report an overlap in cues it had just created itself.
    const usable = safeEnd - start - minGap * (segments.length - 1);
    // Splitting a block too short to divide would mint cues below the editor's
    // own minimum, so those stay whole and keep the colour that opens them.
    if (segments.length > 1 && usable / segments.length < MIN_CUE_DURATION) {
      segments = [
        { color: segments[0].color, text: segments.map((s) => s.text).join("\n") },
      ];
    }

    const share = (safeEnd - start - minGap * (segments.length - 1)) / segments.length;
    segments.forEach((segment, index) => {
      let speakerId: string | null = null;
      if (segment.color) {
        let group = speakers.find((s) => s.color === segment.color);
        if (!group) {
          group = { id: makeId(), color: segment.color, count: 0 };
          speakers.push(group);
        }
        group.count += 1;
        speakerId = group.id;
      }
      const from = start + (share + minGap) * index;
      cues.push({
        id: makeId(),
        start: from,
        // Land the last piece exactly on the block's end, not on rounded shares.
        end: index === segments.length - 1 ? safeEnd : from + share,
        text: segment.text,
        speakerId,
      });
    });

    if (segments.length > 1) split += 1;

    if (end <= start) {
      warnings.push(
        `Cue at ${formatSrtTime(start)} ended before it started; gave it a 1s duration.`,
      );
    }
  }

  // Only the cues are sorted: "first appearance" for a colour means first in the
  // file, which stays the sane reading even when the timecodes are out of order.
  cues.sort((a, b) => a.start - b.start);
  return { cues, speakers, split, warnings };
}

/**
 * Turns the colour groups an `.srt` declared into project speakers. A speaker
 * already using that colour is reused rather than duplicated, so re-importing a
 * corrected export keeps the name and voice notes the user typed.
 */
export function mergeImportedSpeakers(
  existing: Speaker[],
  parsed: ParseResult,
): { cues: Cue[]; speakers: Speaker[] } {
  // Whisper output and plain `.srt` declare no colours. Returning the same array
  // keeps the identity stable, so the memos downstream of it do not churn.
  if (parsed.speakers.length === 0) {
    return { cues: parsed.cues, speakers: existing };
  }

  const speakers = [...existing];
  const byColor = new Map(speakers.map((s) => [s.color.toLowerCase(), s]));
  const usedNames = new Set(speakers.map((s) => s.name.toLowerCase()));
  const idMap = new Map<string, string>();

  for (const found of parsed.speakers) {
    const reused = byColor.get(found.color);
    if (reused) {
      idMap.set(found.id, reused.id);
      continue;
    }
    // One import mints several names at once, so unlike `addSpeaker` this has to
    // step past names already taken rather than trusting the count alone.
    let n = speakers.length + 1;
    while (usedNames.has(`speaker ${n}`)) n += 1;
    const speaker: Speaker = { id: makeId(), name: `Speaker ${n}`, color: found.color };
    speakers.push(speaker);
    usedNames.add(speaker.name.toLowerCase());
    byColor.set(speaker.color, speaker);
    idMap.set(found.id, speaker.id);
  }

  const cues = parsed.cues.map((cue) =>
    cue.speakerId ? { ...cue, speakerId: idMap.get(cue.speakerId) ?? null } : cue,
  );
  return { cues, speakers };
}

export interface SerializeOptions {
  /** Speakers, so each cue can be wrapped in its speaker's colour. */
  speakers?: Speaker[];
  /** Write `<font color="#rrggbb">` around cues that have a speaker. */
  speakerColors?: boolean;
}

/**
 * By default speaker data is stripped: a bare `.srt` stays maximally portable.
 * Pass `{ speakers, speakerColors: true }` to wrap each cue in `<font color=…>`,
 * the convention other subtitle tools use to mark who is speaking, and the form
 * `parseSrt` reads back as speakers.
 */
export function serializeSrt(cues: Cue[], options: SerializeOptions = {}): string {
  const byId = new Map((options.speakers ?? []).map((s) => [s.id, s]));
  const wrap = options.speakerColors === true && byId.size > 0;
  const ordered = [...cues].sort((a, b) => a.start - b.start);
  const blocks = ordered.map((cue, index) => {
    let text = cue.text.replace(/\n{2,}/g, "\n").trim();
    if (wrap) {
      const speaker = cue.speakerId ? byId.get(cue.speakerId) : undefined;
      const color = speaker ? normalizeFontColor(speaker.color) : null;
      // Strip first: a tag typed by hand must not end up nested inside ours.
      // With the toggle off the text goes out exactly as the user wrote it.
      if (color) text = `<font color="${color}">${stripFontTags(text).trim()}</font>`;
    }
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
