/**
 * Fill: the model writes dialogue into slots — timed cues the writer has already
 * placed, or new lines after a point in the script.
 *
 * Everything that decides what the model is told lives here, free of React, so
 * the dialog can show the exact prompt before it is sent and the prompt can be
 * pinned by tests. The Rust side only holds the API key and makes the call.
 *
 * The prompt is three layers:
 *   1. Writing guidance — craft, speech versus thought. Built in, but the writer
 *      can replace it wholesale in Settings.
 *   2. The writer's own instructions from Settings, if any.
 *   3. Conventions — how to read the transcript, the hard limits, the reply
 *      format. Always appended, never replaceable, because the reply has to parse.
 */

import type { Cue, FillLatitude, Section, Speaker } from "../types";
import { MIN_CUE_DURATION } from "./cues";
import { sectionAt, sortSections } from "./sections";
import { durationForText, formatShort } from "./time";

// --- Slots ---------------------------------------------------------------

/** What a slot is voiced as. `choose` leaves it to the model. */
export type SlotMode = "spoken" | "thought" | "choose";

/** How the writer has set up one slot in the dialog. */
export interface SlotSetup {
  /** null leaves the speaker to the model. */
  speakerId: string | null;
  mode: SlotMode;
}

export interface FillSlot {
  /** 1-based; the number the model refers to. */
  number: number;
  /** The cue being filled, or null for a new line in continue mode. */
  cueId: string | null;
  /** Seconds. Null for a new line, whose timing follows from its text. */
  start: number | null;
  end: number | null;
  speakerId: string | null;
  mode: SlotMode;
  /** Text already in the cue. Empty for a new line. */
  draft: string;
  /** Most characters, spaces included, the line may hold. */
  maxChars: number;
}

/** Where Fill writes: into chosen cues, or as new lines after a moment. */
export type FillTarget =
  | { kind: "fill"; cueIds: string[] }
  | { kind: "continue"; after: number; count: number };

export interface ReadingLimits {
  targetCps: number;
  maxCharsPerLine: number;
  maxLines: number;
}

export const MIN_CONTINUE_LINES = 1;
export const MAX_CONTINUE_LINES = 8;
export const MIN_TAKES = 1;
export const MAX_TAKES = 4;

/** Silences at least this long are called out in the transcript. */
const PAUSE_THRESHOLD = 2.5;

/**
 * The most characters a slot can hold: what can be read in the time it is on
 * screen, and never more than the cue's line limits allow.
 */
export function slotCharLimit(seconds: number, limits: ReadingLimits): number {
  const byLayout = Math.max(1, limits.maxCharsPerLine * limits.maxLines);
  if (!Number.isFinite(seconds)) return byLayout;
  const bySpeed = Math.floor(Math.max(0, seconds) * limits.targetCps);
  return Math.max(1, Math.min(bySpeed, byLayout));
}

/**
 * The free stretch of timeline new lines can go into: from `after` — or the end
 * of a cue it lands inside — to the start of the next cue. `end` is Infinity
 * when there is nothing after it and no media length to stop at.
 */
export function continueWindow(
  cues: Cue[],
  after: number,
  duration: number,
  minGap: number,
): { start: number; end: number } {
  let start = Math.max(0, after);
  // A cue that covers the moment, or ends too close to it, pushes the start on.
  for (const cue of cues) {
    if (cue.start <= start && cue.end + minGap > start) start = cue.end + minGap;
  }
  const next = cues.find((cue) => cue.start >= start);
  const limit = duration > 0 ? duration : Infinity;
  const end = Math.min(next ? next.start - minGap : limit, limit);
  return { start, end: Math.max(start, end) };
}

/** The slots a target describes, with the writer's per-slot setup applied. */
export function buildSlots(
  target: FillTarget,
  cues: Cue[],
  setups: SlotSetup[],
  limits: ReadingLimits,
  window: { start: number; end: number } | null,
  minGap: number,
): FillSlot[] {
  if (target.kind === "fill") {
    const wanted = new Set(target.cueIds);
    return cues
      .filter((cue) => wanted.has(cue.id))
      .map((cue, i) => {
        const setup = setups[i] ?? defaultSetupFor(cue);
        return {
          number: i + 1,
          cueId: cue.id,
          start: cue.start,
          end: cue.end,
          speakerId: setup.speakerId,
          mode: setup.mode,
          draft: cue.text.replace(/\s+/g, " ").trim(),
          maxChars: slotCharLimit(cue.end - cue.start, limits),
        };
      });
  }

  const count = clampInt(target.count, MIN_CONTINUE_LINES, MAX_CONTINUE_LINES);
  // New lines share the window, so each gets an even share of its reading time.
  const span = window ? window.end - window.start : Infinity;
  const perLine = (span - (count - 1) * minGap) / count;
  const maxChars = slotCharLimit(perLine, limits);

  return Array.from({ length: count }, (_, i) => {
    const setup = setups[i] ?? { speakerId: null, mode: "choose" as const };
    return {
      number: i + 1,
      cueId: null,
      start: null,
      end: null,
      speakerId: setup.speakerId,
      mode: setup.mode,
      draft: "",
      maxChars,
    };
  });
}

/** A cue's own speaker and mode; an untagged cue leaves the speaker open. */
export function defaultSetupFor(cue: Cue): SlotSetup {
  return {
    speakerId: cue.speakerId,
    mode: cue.mode === "thought" ? "thought" : "spoken",
  };
}

// --- Transcript -----------------------------------------------------------

export type TranscriptItem =
  | { kind: "line"; cue: Cue }
  | { kind: "slot"; slot: FillSlot }
  | { kind: "pause"; seconds: number }
  | { kind: "scene"; section: Section };

/**
 * The stretch of script the model reads: up to `before` cues ahead of the first
 * slot, every cue between the slots, up to `after` cues past the last one, and
 * the slots themselves in place — with pauses and scene changes called out.
 */
export function buildTranscript(
  cues: Cue[],
  slots: FillSlot[],
  sections: Section[],
  before: number,
  after: number,
  window: { start: number; end: number } | null,
): TranscriptItem[] {
  const slotCueIds = new Set(slots.map((s) => s.cueId).filter(Boolean));
  const context = cues.filter((cue) => !slotCueIds.has(cue.id));

  // Where the slots begin and end on the timeline.
  const timed = slots.filter((s) => s.start !== null);
  const from = timed.length > 0 ? timed[0].start! : (window?.start ?? Infinity);
  const to =
    timed.length > 0
      ? Math.max(...timed.map((s) => s.end!))
      : (window?.end ?? Infinity);

  const ahead = context.filter((cue) => cue.start < from);
  const between = context.filter((cue) => cue.start >= from && cue.start < to);
  const behind = context.filter((cue) => cue.start >= to);

  type Placed = { time: number; end: number | null; item: TranscriptItem };
  const placed: Placed[] = [
    ...ahead.slice(Math.max(0, ahead.length - Math.max(0, before))),
    ...between,
    ...behind.slice(0, Math.max(0, after)),
  ].map((cue) => ({ time: cue.start, end: cue.end, item: { kind: "line", cue } }));

  for (const slot of slots) {
    placed.push({
      time: slot.start ?? from,
      end: slot.end,
      item: { kind: "slot", slot },
    });
  }
  // Stable, so new lines keep their order and sit after any cue at the same time.
  placed.sort((a, b) => a.time - b.time);

  const items: TranscriptItem[] = [];
  let scene: Section | null = null;
  let previousEnd: number | null = null;
  for (const entry of placed) {
    // A new line's position is nominal, so the silence before it means nothing.
    const hasOwnTime = entry.item.kind === "line" || entry.end !== null;
    if (previousEnd !== null && hasOwnTime) {
      const gap = entry.time - previousEnd;
      if (gap >= PAUSE_THRESHOLD) items.push({ kind: "pause", seconds: gap });
    }

    const here = sectionAt(sections, entry.time);
    if (here && here.id !== scene?.id) items.push({ kind: "scene", section: here });
    scene = here;

    items.push(entry.item);
    // A new line has no end of its own, so the silence after it is unknown.
    previousEnd = entry.end;
  }
  return items;
}

/** Sections whose scene headings appear in the transcript, in time order. */
export function scenesIn(items: TranscriptItem[]): Section[] {
  const seen = new Map<string, Section>();
  for (const item of items) {
    if (item.kind === "scene") seen.set(item.section.id, item.section);
  }
  return sortSections([...seen.values()]);
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function speakerName(speakers: Speaker[], id: string | null): string | null {
  const name = speakers.find((s) => s.id === id)?.name.trim();
  return name ? name : null;
}

export function renderTranscript(items: TranscriptItem[], speakers: Speaker[]): string {
  return items
    .map((item) => {
      switch (item.kind) {
        case "scene":
          return `== Scene: ${oneLine(item.section.label) || "untitled"} ==`;
        case "pause":
          return `(pause ${item.seconds.toFixed(1)}s)`;
        case "line": {
          const { cue } = item;
          const who = speakerName(speakers, cue.speakerId) ?? "Someone";
          const verb = cue.mode === "thought" ? "thinks" : "says";
          const text = oneLine(cue.text) || "…";
          return `[${formatShort(cue.start)}] ${who} ${verb}: ${text}`;
        }
        case "slot": {
          const { slot } = item;
          const parts = [
            `«SLOT ${slot.number}»`,
            `speaker: ${speakerName(speakers, slot.speakerId) ?? "your choice"}`,
            `mode: ${slot.mode === "choose" ? "your choice" : slot.mode === "thought" ? "thinks" : "says"}`,
          ];
          if (slot.start !== null && slot.end !== null) {
            parts.push(`on screen ${(slot.end - slot.start).toFixed(1)}s`);
          } else {
            parts.push("new line");
          }
          parts.push(`max ${slot.maxChars} characters`);
          if (slot.draft) parts.push(`draft: "${slot.draft}"`);
          const stamp = slot.start !== null ? `[${formatShort(slot.start)}] ` : "";
          return `${stamp}${parts.join(" | ")}`;
        }
      }
    })
    .join("\n");
}

// --- Prompt ---------------------------------------------------------------

/**
 * The craft layer. Settings shows this as the starting point for a custom
 * override, so it is written to be read and edited by a person.
 */
export const DEFAULT_FILL_GUIDANCE = `You write dialogue for a subtitled video. You are given a stretch of a scene with gaps in it — slots — and you write what the characters say, or think, in each one.

You have real creative freedom, and you are expected to use it. Lines that are merely plausible are a failure; the writer can produce those without you. Aim for lines that feel inevitable in hindsight and could only belong to this character in this moment.

Craft
- Everyone in a scene wants something right now. Write from that want, not from what the plot needs to convey.
- Subtext beats statement. People deflect, joke, accuse, change the subject, or answer a question nobody asked instead of naming their feelings.
- Be specific. One concrete detail — a name, an object, a number, a place — does more than any general sentiment.
- Make it sound spoken: contractions, fragments, interruptions, a thought abandoned halfway. Nobody talks in tidy, complete paragraphs.
- Give each character a voice of their own — vocabulary, rhythm, what they notice, what they avoid. Their lines should be recognisable without the name.
- Short is strong. A subtitle has seconds to land; cut every word that is not pulling weight.
- Connect in both directions: a slot answers what came before it and leads naturally into what comes after it.
- Keep continuity: honour every fact, name, relationship and running joke established anywhere in the material. Never contradict it.
- No stock dialogue. Avoid lines like "We need to talk", "I can't believe this", "It's not what it looks like", "Are you okay?", "Let me explain", "You don't understand", "This changes everything" — and their equivalents in any language. If a line could be dropped into any film, it is the wrong line.
- Do not explain the scene, recap what the audience has seen, or wrap things up neatly.

Speech and thought
- Speech is a performance for whoever is listening. It is shaped by what the speaker wants from them and what they dare to show.
- Thought is private and unguarded: more honest, more fragmentary, often present tense — sometimes a single word or image. It is where a character admits what they will not say.
- A thought earns its place through tension with speech: fear under bravado, affection under an insult, a plan under small talk. A thought that only repeats what was said aloud is wasted.
- A thought is usually shorter than speech. A thought that reads like a speech is a speech.`;

function conventions(takes: number): string {
  const lines = [
    "Reading the material",
    '- Transcript lines are "[time] Name says: text" (spoken aloud; everyone present hears it) or "[time] Name thinks: text" (inner voice; nobody else can hear it).',
    "- Only the thinker knows a thought. Other characters cannot hear, answer or react to it — never write a spoken line that responds to another character's thought. A character's own later lines may be shaped by their own thoughts.",
    '- "(pause 4.2s)" marks a silence between lines. "== Scene: name ==" marks where a scene begins.',
    '- «SLOT n» marks a gap you fill. It says who speaks ("your choice" means pick one of the listed characters), whether it is spoken or thought ("your choice" means you decide), how long it is on screen, and the most characters it may hold. A slot may carry the writer\'s draft.',
    "",
    "Hard limits — these override everything else, including the writer's direction and instructions",
    "- Stay within each slot's character limit, counting spaces. It is a reading-speed limit: a longer subtitle cannot be read before it disappears.",
    "- Write only the words spoken or thought. No speaker names, quotation marks, asterisks, stage directions, parentheticals or line breaks.",
    "- Write in the language of the transcript.",
    "- A slot that names a speaker or a mode keeps it.",
    "",
    "Reply format",
    "Reply with JSON only — no commentary, no code fence — in exactly this shape:",
    '{"takes": [{"approach": "a few words on what this take does", "lines": [{"slot": 1, "speaker": "Name", "mode": "says", "text": "The line."}]}]}',
    '- "mode" is "says" or "thinks".',
    `- Give exactly ${takes} ${takes === 1 ? "take" : "takes"}. Each take fills every slot exactly once, in slot order.`,
  ];
  if (takes > 1) {
    lines.push(
      "- Make the takes genuinely different readings of the moment — a different intent, attitude or turn — never rewordings of one idea.",
    );
  }
  return lines.join("\n");
}

const LATITUDE: Record<FillLatitude, string> = {
  close:
    "Creative latitude: close. Stay tightly within what is established — tone, stakes, facts and each character's manner. The lines should feel like the obvious-in-hindsight right thing to say; surprise only through precision.",
  open:
    "Creative latitude: open. Stay true to the characters and the story, but make bold, specific choices rather than safe ones. Let a line reveal something, sharpen a conflict, or land a joke.",
  wild:
    "Creative latitude: wild. Take the moment somewhere unexpected — a reversal, a confession, a lie, a sudden change of mood — as long as the characters stay recognisable and the lines still lead into what follows. Every hard limit still applies.",
};

export const LATITUDE_LABELS: Record<FillLatitude, string> = {
  close: "Close",
  open: "Open",
  wild: "Wild",
};

export function isLatitude(value: string): value is FillLatitude {
  return value === "close" || value === "open" || value === "wild";
}

export type DraftHandling = "complete" | "rewrite";

const DRAFTS: Record<DraftHandling, string> = {
  complete:
    "Some slots carry the writer's draft. Keep its meaning and as much of its wording as works; finish it if it is incomplete, and tighten it if it runs over the limit.",
  rewrite:
    "Some slots carry the writer's draft. Treat it only as a rough note of intent — rewrite it freely.",
};

export interface PromptInput {
  target: FillTarget;
  slots: FillSlot[];
  transcript: TranscriptItem[];
  speakers: Speaker[];
  brief: string;
  beats: string[];
  direction: string;
  latitude: FillLatitude;
  drafts: DraftHandling;
  takes: number;
  /** Settings: replaces the built-in guidance when non-blank. */
  guidanceOverride: string;
  /** Settings: the writer's standing instructions. */
  instructions: string;
}

export function buildSystemPrompt(input: PromptInput): string {
  const guidance = input.guidanceOverride.trim() || DEFAULT_FILL_GUIDANCE;
  const parts = [guidance];
  const instructions = input.instructions.trim();
  if (instructions) {
    parts.push(
      `Standing instructions from the writer. Follow them; where they conflict with the guidance above, they win:\n${instructions}`,
    );
  }
  parts.push(conventions(clampInt(input.takes, MIN_TAKES, MAX_TAKES)));
  return parts.join("\n\n");
}

export function buildUserPrompt(input: PromptInput): string {
  const sections: string[] = [];

  const brief = input.brief.trim();
  if (brief) sections.push(`## Project brief\n${brief}`);

  const beats = input.beats.map((b) => b.trim()).filter(Boolean);
  if (beats.length > 0) {
    sections.push(
      `## Story beats\nThe core beats of the whole story, in order. Lines should fit this story and move toward the beats that have not happened yet.\n${beats
        .map((beat, i) => `${i + 1}. ${beat}`)
        .join("\n")}`,
    );
  }

  if (input.speakers.length > 0) {
    const cast = input.speakers.map((speaker) => {
      const lines = [`- ${speaker.name.trim() || "Unnamed"}`];
      const voice = oneLine(speaker.voiceNotes ?? "");
      const inner = oneLine(speaker.innerVoice ?? "");
      if (voice) lines.push(`  Voice: ${voice}`);
      if (inner) lines.push(`  Inner voice: ${inner}`);
      return lines.join("\n");
    });
    sections.push(`## Characters\n${cast.join("\n")}`);
  }

  const scenes = scenesIn(input.transcript).filter((s) => oneLine(s.note ?? ""));
  if (scenes.length > 0) {
    sections.push(
      `## Scene notes\n${scenes
        .map((s) => `- ${oneLine(s.label) || "untitled"}: ${oneLine(s.note ?? "")}`)
        .join("\n")}`,
    );
  }

  sections.push(`## Transcript\n${renderTranscript(input.transcript, input.speakers)}`);

  const count = input.slots.length;
  const range = count === 1 ? "slot 1" : `slots 1–${count}`;
  const task = [
    input.target.kind === "fill"
      ? `Fill ${range}.`
      : `Write the ${count === 1 ? "next line" : `next ${count} lines`} (${range}), continuing from the last line before them.`,
  ];
  if (input.slots.some((slot) => slot.draft)) task.push(DRAFTS[input.drafts]);
  task.push(LATITUDE[input.latitude]);
  sections.push(`## Task\n${task.join("\n")}`);

  // Last, so it is the freshest thing the model reads.
  const direction = input.direction.trim();
  sections.push(
    direction
      ? `## Direction from the writer\n${direction}`
      : "## Direction from the writer\nNone given. Read the scene and decide what the moment needs.",
  );

  return sections.join("\n\n");
}

/** Room for every take's JSON, plus a margin for a model that thinks aloud. */
export function maxTokensFor(slots: number, takes: number): number {
  return 400 + takes * (40 + slots * 90);
}

// --- Reply ----------------------------------------------------------------

export interface TakeLine {
  speakerName: string;
  /** Null when the model did not say; the slot's own mode then decides. */
  mode: "spoken" | "thought" | null;
  text: string;
}

export interface Take {
  approach: string;
  /** Indexed by slot number − 1. A slot the model skipped is null. */
  lines: Array<TakeLine | null>;
}

function stripFence(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}

function parseJsonLoosely(content: string): unknown {
  const cleaned = stripFence(content);
  try {
    return JSON.parse(cleaned);
  } catch {
    // A preamble or a trailing remark: take the outermost bracketed value.
  }
  const opens = [cleaned.indexOf("{"), cleaned.indexOf("[")].filter((i) => i >= 0);
  if (opens.length === 0) return null;
  const start = Math.min(...opens);
  const close = cleaned[start] === "{" ? "}" : "]";
  const end = cleaned.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Wrapping quotes and thought asterisks are ours to add, not the model's. */
function cleanText(raw: string): string {
  let text = oneLine(raw);
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["“", "”"],
    ["«", "»"],
    ["*", "*"],
    ["_", "_"],
  ];
  for (const [open, close] of pairs) {
    if (text.length > 1 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, text.length - close.length).trim();
    }
  }
  return text;
}

function parseMode(raw: unknown): TakeLine["mode"] {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (["thinks", "think", "thought", "inner"].includes(value)) return "thought";
  if (["says", "say", "said", "spoken", "speech"].includes(value)) return "spoken";
  return null;
}

function parseTake(raw: unknown, slotCount: number): Take | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const rawLines = Array.isArray(raw) ? raw : record.lines;
  if (!Array.isArray(rawLines)) return null;

  const lines: Array<TakeLine | null> = Array.from({ length: slotCount }, () => null);
  rawLines.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) return;
    const line = entry as Record<string, unknown>;
    if (typeof line.text !== "string") return;
    const text = cleanText(line.text);
    if (!text) return;

    // Trust the slot number when it is usable, and the position when it is not.
    const numbered = Number(line.slot);
    const slot = Number.isInteger(numbered) && numbered >= 1 ? numbered : index + 1;
    if (slot > slotCount || lines[slot - 1]) return;

    lines[slot - 1] = {
      speakerName: typeof line.speaker === "string" ? line.speaker.trim() : "",
      mode: parseMode(line.mode),
      text,
    };
  });

  if (lines.every((line) => line === null)) return null;
  const approach =
    !Array.isArray(raw) && typeof record.approach === "string"
      ? oneLine(record.approach)
      : "";
  return { approach, lines };
}

/**
 * Reads the model's reply. Tolerates a code fence, a chatty preamble, a bare
 * array of takes, or a single take's bare array of lines. Throws when nothing
 * usable is in it, so the dialog can say so rather than show an empty result.
 */
export function parseFillReply(content: string, slotCount: number): Take[] {
  const parsed = parseJsonLoosely(content);
  let rawTakes: unknown[] = [];

  if (Array.isArray(parsed)) {
    const looksLikeLines = parsed.some(
      (entry) => typeof entry === "object" && entry !== null && "text" in entry,
    );
    rawTakes = looksLikeLines ? [{ lines: parsed }] : parsed;
  } else if (typeof parsed === "object" && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.takes)) rawTakes = record.takes;
    else if (Array.isArray(record.lines)) rawTakes = [record];
  }

  const takes = rawTakes
    .map((raw) => parseTake(raw, slotCount))
    .filter((take): take is Take => take !== null);
  if (takes.length === 0) {
    throw new Error("The model's reply could not be read as lines for these slots.");
  }
  return takes;
}

/** The speaker a take line names, when it matches one of ours. */
export function speakerIdForName(speakers: Speaker[], name: string): string | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  return speakers.find((s) => s.name.trim().toLowerCase() === wanted)?.id ?? null;
}

/**
 * The speaker and mode a take line lands with: whatever the slot fixed, and the
 * model's choice only where the slot left it open.
 */
export function resolveLine(
  slot: FillSlot,
  line: TakeLine,
  speakers: Speaker[],
): { speakerId: string | null; mode: "spoken" | "thought" } {
  return {
    speakerId: slot.speakerId ?? speakerIdForName(speakers, line.speakerName),
    mode: slot.mode === "choose" ? (line.mode ?? "spoken") : slot.mode,
  };
}

// --- Placing new lines ------------------------------------------------------

/**
 * Timing for new lines, laid end to end from the window's start: each as long
 * as its text needs at the target reading speed. When they will not all fit,
 * every line shrinks by the same factor; when even that leaves a line shorter
 * than a cue may be, there is no room and the result is null.
 */
export function layoutContinuation(
  texts: string[],
  window: { start: number; end: number },
  targetCps: number,
  minGap: number,
): Array<{ start: number; end: number }> | null {
  if (texts.length === 0) return [];
  const wanted = texts.map((text) => Math.max(durationForText(text, targetCps), 1));
  const gaps = (texts.length - 1) * minGap;
  const needed = wanted.reduce((sum, d) => sum + d, 0);
  const available = window.end - window.start - gaps;

  const scale = needed <= available ? 1 : available / needed;
  if (!(scale > 0) || Math.min(...wanted) * scale < MIN_CUE_DURATION) return null;

  const slots: Array<{ start: number; end: number }> = [];
  let at = window.start;
  for (const duration of wanted) {
    const length = duration * scale;
    slots.push({ start: at, end: at + length });
    at += length + minGap;
  }
  return slots;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
