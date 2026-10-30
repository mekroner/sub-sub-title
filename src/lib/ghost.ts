/**
 * Ghost text: the grey continuation shown after the caret while a cue is typed,
 * accepted with Tab.
 *
 * It runs on every typing pause, so it is built to be cheap: a small model, a
 * short reply, and a prompt whose volatile part — what has been typed — comes
 * last, so a provider's prefix cache covers everything before it. Most
 * keystrokes never reach the model at all: typing the characters the ghost
 * already shows just shortens it (`advanceGhost`).
 *
 * Everything here is free of React so the prompt and the reply handling can be
 * pinned by tests. The transcript format is Fill's, so the two features read
 * the script the same way.
 */

import type { Cue, Speaker } from "../types";
import {
  buildTranscript,
  renderTranscript,
  slotCharLimit,
  type FillSlot,
  type ReadingLimits,
} from "./fill";
import { formatShort } from "./time";

/** Below this many characters of room there is nothing worth suggesting. */
const MIN_BUDGET = 2;

/** A reply may run this far past the budget before it is cut back. */
const BUDGET_SLACK = 8;

/** Marks the line being typed inside the transcript. */
const CURSOR_MARK = "«TYPING»";

export interface GhostInput {
  cues: Cue[];
  speakers: Speaker[];
  cueId: string;
  /** What is in the cue right now; the ghost continues from its end. */
  prefix: string;
  linesBefore: number;
  linesAfter: number;
  limits: ReadingLimits;
}

export interface GhostPrompt {
  system: string;
  user: string;
  maxTokens: number;
  /** Characters the continuation may add. */
  charBudget: number;
  /** The cue's speaker, so an echoed "Name:" can be stripped from the reply. */
  speakerName: string | null;
}

export const GHOST_SYSTEM_PROMPT = `You are an inline autocomplete for subtitle dialogue. A writer is typing one subtitle line, and you predict the rest of it — the way a code editor suggests the rest of a line.

Reading the material
- Transcript lines are "[time] Name says: text" (spoken aloud) or "[time] Name thinks: text" (private inner voice nobody else hears).
- "(pause 4.2s)" marks a silence. ${CURSOR_MARK} marks the line being typed; what has been typed so far is given at the end.

Rules
- Reply with only the continuation: the characters that come after the typed text. Never repeat the typed text.
- If the typed text ends in the middle of a word, continue that word with no leading space. If it ends after a complete word or punctuation, begin with a space.
- If nothing has been typed, write the whole line.
- Finish this one line and stop. No line breaks, quotation marks, speaker names, stage directions or commentary.
- Stay within the character budget you are given. Shorter is better than longer.
- Match the language, register and voice of the transcript and of this speaker. The line answers what comes before it and leads naturally into what comes after it.
- Continue the writer's thought in the direction they are already taking it; do not change the subject.
- If the typed text already reads as a finished line, reply with nothing at all.`;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The request for one cue, or null when there is nothing to ask: the cue is
 * gone, or its text already fills what can be read in its time on screen.
 */
export function buildGhostPrompt(input: GhostInput): GhostPrompt | null {
  const cue = input.cues.find((c) => c.id === input.cueId);
  if (!cue) return null;

  const limit = slotCharLimit(cue.end - cue.start, input.limits);
  const charBudget = limit - input.prefix.length;
  if (charBudget < MIN_BUDGET) return null;

  const thought = cue.mode === "thought";
  const slot: FillSlot = {
    number: 1,
    cueId: cue.id,
    start: cue.start,
    end: cue.end,
    speakerId: cue.speakerId,
    mode: thought ? "thought" : "spoken",
    draft: "",
    maxChars: limit,
  };

  // No sections: scene headings cost tokens on every keystroke-pause for little
  // gain in finishing a single line.
  const items = buildTranscript(
    input.cues,
    [slot],
    [],
    Math.max(0, input.linesBefore),
    Math.max(0, input.linesAfter),
    null,
  );

  const speaker = input.speakers.find((s) => s.id === cue.speakerId) ?? null;
  const name = speaker?.name.trim() || null;
  const who = name ?? "Someone";
  const verb = thought ? "thinks" : "says";

  const transcript = items
    .map((item) =>
      item.kind === "slot"
        ? `[${formatShort(cue.start)}] ${who} ${verb}: ${CURSOR_MARK}`
        : renderTranscript([item], input.speakers),
    )
    .join("\n");

  const sections: string[] = [];

  if (speaker) {
    const lines = [`## Speaker\n${who}`];
    const voice = oneLine(speaker.voiceNotes ?? "");
    const inner = oneLine(speaker.innerVoice ?? "");
    if (voice) lines.push(`Voice: ${voice}`);
    if (inner) lines.push(`Inner voice: ${inner}`);
    sections.push(lines.join("\n"));
  }

  sections.push(`## Transcript\n${transcript}`);

  // Everything that changes as the writer types sits below this point.
  const kind = thought
    ? `${who} thinks this line (private inner voice).`
    : `${who} says this line aloud.`;
  const typed = input.prefix.replace(/\n/g, " ");
  sections.push(
    [
      "## The line being typed",
      kind,
      `On screen ${(cue.end - cue.start).toFixed(1)}s: at most ${limit} characters in all, so add no more than ${charBudget}.`,
      typed.trim()
        ? `Typed so far (continue from its very last character): ${JSON.stringify(typed)}`
        : "Nothing typed yet — write the whole line.",
    ].join("\n"),
  );

  return {
    system: GHOST_SYSTEM_PROMPT,
    user: sections.join("\n\n"),
    maxTokens: maxTokensForBudget(charBudget),
    charBudget,
    speakerName: name,
  };
}

/** Roughly three characters a token, plus room for a stray leading word. */
export function maxTokensForBudget(charBudget: number): number {
  return Math.min(96, Math.max(16, Math.ceil(charBudget / 3) + 12));
}

const WRAPPING_PAIRS: Array<[string, string]> = [
  ['"', '"'],
  ["“", "”"],
  ["«", "»"],
  ["*", "*"],
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Turns the model's reply into text that can sit directly after `prefix`, or
 * null when there is nothing worth showing.
 *
 * Small models are loose with instructions, so this undoes the usual slips: the
 * typed text repeated, a speaker name, wrapping quotes, line breaks, a space
 * too many or too few at the join.
 */
export function reconcileGhost(
  prefix: string,
  raw: string,
  options: { charBudget: number; speakerName?: string | null },
): string | null {
  const hadLeadingSpace = /^\s/.test(raw);
  let text = raw.replace(/\s+/g, " ").trim();

  const name = options.speakerName?.trim();
  if (name) {
    text = text
      .replace(new RegExp(`^${escapeRegExp(name)}\\s*(says|thinks)?\\s*:\\s*`, "i"), "")
      .trim();
  }

  for (const [open, close] of WRAPPING_PAIRS) {
    if (text.length > 1 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, text.length - close.length).trim();
    }
  }

  let leadingSpace = hadLeadingSpace;
  const typed = prefix.replace(/\s+/g, " ").trim();
  if (typed && text.toLowerCase().startsWith(typed.toLowerCase())) {
    // The whole line came back; keep only what follows the typed part.
    const rest = text.slice(typed.length);
    leadingSpace = /^\s/.test(rest);
    text = rest.trim();
  } else if (text.startsWith(CURSOR_MARK)) {
    text = text.slice(CURSOR_MARK.length).trim();
  }

  if (!text) return null;

  // The join. After whitespace, or with nothing typed, the ghost starts flush.
  // After punctuation a new word needs a space whatever the model sent. After a
  // letter, the model's own leading space tells a new word from a finished one.
  let joined: string;
  if (prefix === "" || /\s$/.test(prefix)) {
    joined = text;
  } else if (/^[,.;:!?…)\]'’-]/.test(text)) {
    joined = text;
  } else if (/[,.;:!?…]$/.test(prefix)) {
    joined = ` ${text}`;
  } else {
    joined = leadingSpace ? ` ${text}` : text;
  }

  return fitToBudget(joined, options.charBudget);
}

/** Cuts a reply that runs well past the budget back to a word boundary. */
function fitToBudget(ghost: string, charBudget: number): string | null {
  const ceiling = Math.max(0, charBudget) + BUDGET_SLACK;
  if (ghost.length <= ceiling) return ghost;
  const cut = ghost.slice(0, ceiling + 1);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = (lastSpace > 0 ? cut.slice(0, lastSpace) : "").trimEnd();
  return trimmed.trim() ? trimmed : null;
}

export interface GhostState {
  cueId: string;
  /** The cue text the ghost was shown after. */
  prefix: string;
  /** The grey text itself. */
  text: string;
}

/**
 * The ghost after the cue's text changed to `next`, without asking the model:
 * typing what the ghost shows eats into it. Returns the remaining ghost — ""
 * when it has all been typed — or null when the edit went somewhere else and a
 * fresh suggestion is needed.
 */
export function advanceGhost(ghost: Pick<GhostState, "prefix" | "text">, next: string): string | null {
  if (!next.startsWith(ghost.prefix)) return null;
  const typed = next.slice(ghost.prefix.length);
  if (!ghost.text.startsWith(typed)) return null;
  return ghost.text.slice(typed.length);
}

/** The next word of a ghost, with the space before it: what Ctrl+→ accepts. */
export function nextGhostWord(ghost: string): string {
  return /^\s*[^\s]+/.exec(ghost)?.[0] ?? ghost;
}

/**
 * A small least-recently-used cache of suggestions, so backspacing over a
 * word and typing it again does not pay for the same request twice.
 */
export class GhostCache {
  private readonly entries = new Map<string, string | null>();

  constructor(private readonly capacity = 50) {}

  static key(cue: Pick<Cue, "id" | "speakerId" | "mode">, prefix: string): string {
    return `${cue.id} ${cue.speakerId ?? ""} ${cue.mode ?? ""} ${prefix}`;
  }

  /** undefined when absent; null records that the model had nothing to add. */
  get(key: string): string | null | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key)!;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: string | null): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
