/**
 * `/continue`: the chat model writes the next stretch of the script itself,
 * with tools to read, add, edit, move and delete cues inside a window of time
 * starting at the playhead. It works turn by turn — call tools, read what they
 * did — until it says it is done.
 *
 * Everything that decides what the model is told and what its tool calls do to
 * the cues lives here, free of React, so it can be pinned by tests. The tools
 * refuse rather than quietly adjust what they are asked: a model that reads
 * "overlaps c7" learns where the room is, one whose line was silently clamped
 * does not.
 */

import type {
  AgentMessage,
  AgentReply,
  AgentRequest,
  AgentRun,
  AgentStep,
  ChatEffort,
  Cue,
  Section,
  Speaker,
  TimedBeat,
  WriterAnswer,
  WriterQuestion,
} from "../types";
import { renderCurrentScene } from "./chat";
import { MIN_CUE_DURATION, newCue, sortCues } from "./cues";
import { renderProjectContext, speakerIdForName } from "./fill";
import { sectionAt } from "./sections";
import { beatsBetween, renderTimedBeats } from "./timedBeats";
import { unwrapThought, wrapText } from "./text";
import { CPS_WARNING, charsPerSecond, durationForText, formatShort } from "./time";

export const DEFAULT_CONTINUE_SECONDS = 30;
export const MIN_CONTINUE_SECONDS = 5;
export const MAX_CONTINUE_SECONDS = 300;

/** Model turns a run may take before it is stopped. */
export const MAX_AGENT_STEPS = 30;

/** Frames a run may have described: each is a slow, paid call. */
export const MAX_LOOKS = 6;

/** Questions a run may put to the writer: it should mostly just write. */
export const MAX_QUESTIONS = 2;
/** Longest question, and longest option label or description, kept. */
const QUESTION_CHARS = 200;
const LABEL_CHARS = 60;

/** Per turn: room for a handful of tool calls, or thinking and then some. */
export const AGENT_MAX_TOKENS = 4000;
export const AGENT_MAX_TOKENS_REASONING = 12000;

/** Lines past the window shown read-only, so the run can lead into them. */
const LINES_AFTER = 3;
/** Planned beats past the window shown, so the run knows where the scene heads. */
const BEATS_AFTER = 2;
/** Most lines one `read_cues` returns. */
const READ_LIMIT = 80;
const PAUSE_THRESHOLD = 2.5;
/** Float slack when comparing times. */
const EPSILON = 1e-6;

// --- The command ------------------------------------------------------------

/**
 * `/continue`, `/continue 45`, `/continue 45s Ben finally admits it` — or null
 * for any other message.
 */
export function parseContinueCommand(text: string): { seconds: number; direction: string } | null {
  const match = /^\/continue(?:\s+|$)(.*)$/is.exec(text.trim());
  if (!match) return null;
  const rest = match[1].trim();
  const number = /^(\d+(?:\.\d+)?)\s*s?(?:\s+|$)(.*)$/is.exec(rest);
  const seconds = number ? Number(number[1]) : DEFAULT_CONTINUE_SECONDS;
  return {
    seconds: Math.min(MAX_CONTINUE_SECONDS, Math.max(MIN_CONTINUE_SECONDS, seconds)),
    direction: (number ? number[2] : rest).trim(),
  };
}

// --- The run's world --------------------------------------------------------

export interface AgentEnv {
  /** Seconds: the only stretch the run may change. */
  window: { start: number; end: number };
  /** Seconds; 0 when unknown. */
  duration: number;
  /** Whether the run may look at frames, through a vision model. */
  vision: boolean;
  speakers: Speaker[];
  sections: Section[];
  targetCps: number;
  minGap: number;
  maxCharsPerLine: number;
  maxLines: number;
}

/** `seconds` from the playhead, cut short at the end of the video. */
export function agentWindow(
  currentTime: number,
  seconds: number,
  duration: number,
): { start: number; end: number } {
  const end = currentTime + seconds;
  return { start: currentTime, end: duration > 0 ? Math.min(end, duration) : end };
}

/**
 * Short names for cues — `c1`, `c2` — that hold for the whole run. Cheaper
 * than ids, and a model cannot plausibly invent one that happens to exist.
 */
export interface Aliases {
  /** `c` for cues; a story run also names sections `s…` and beats `b…`. */
  prefix: string;
  byId: Map<string, string>;
  byAlias: Map<string, string>;
}

export function createAliases(prefix = "c"): Aliases {
  return { prefix, byId: new Map(), byAlias: new Map() };
}

export function aliasFor(aliases: Aliases, id: string): string {
  let alias = aliases.byId.get(id);
  if (!alias) {
    alias = `${aliases.prefix}${aliases.byId.size + 1}`;
    aliases.byId.set(id, alias);
    aliases.byAlias.set(alias, id);
  }
  return alias;
}

function inWindow(env: AgentEnv, start: number, end: number): boolean {
  return start >= env.window.start - EPSILON && end <= env.window.end + EPSILON;
}

export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const span = (start: number, end: number) => `${formatShort(start)}–${formatShort(end)}`;
const windowLabel = (env: AgentEnv) => span(env.window.start, env.window.end);

function speakerName(speakers: Speaker[], id: string | null): string {
  return speakers.find((s) => s.id === id)?.name.trim() || "Someone";
}

/** One cue as the model reads it: `c4 [1:21.40–1:23.10] Anna says: … (16 cps)`. */
function renderCue(cue: Cue, env: AgentEnv, aliases: Aliases): string {
  const verb = cue.mode === "thought" ? "thinks" : "says";
  const cps = Math.round(charsPerSecond(cue.text, cue.start, cue.end));
  const notes = [`${cps} cps${cps > CPS_WARNING ? " — too fast" : ""}`];
  if (!inWindow(env, cue.start, cue.end)) notes.push("outside window");
  const who = speakerName(env.speakers, cue.speakerId);
  return `${aliasFor(aliases, cue.id)} [${span(cue.start, cue.end)}] ${who} ${verb}: ${oneLine(cue.text) || "…"} (${notes.join(", ")})`;
}

/** Cues in time order with silences and scene changes called out. */
export function renderLines(cues: Cue[], env: AgentEnv, aliases: Aliases): string {
  const out: string[] = [];
  let scene: Section | null = null;
  let previousEnd: number | null = null;
  for (const cue of cues) {
    if (previousEnd !== null && cue.start - previousEnd >= PAUSE_THRESHOLD) {
      out.push(`(pause ${(cue.start - previousEnd).toFixed(1)}s)`);
    }
    const here = sectionAt(env.sections, cue.start);
    if (here && here.id !== scene?.id) out.push(`== Scene: ${oneLine(here.label) || "untitled"} ==`);
    scene = here;
    out.push(renderCue(cue, env, aliases));
    previousEnd = cue.end;
  }
  return out.join("\n");
}

/** Cues that touch `from`–`to`, in time order. */
export function cuesBetween(cues: Cue[], from: number, to: number): Cue[] {
  return sortCues(cues).filter((c) => c.end > from && c.start < to);
}

// --- Tools -------------------------------------------------------------------

export const timeParam = (description: string) => ({ type: "number", description });

/** `ask_writer`, with the guidance that fits the kind of run. */
export function askTool(description: string) {
  return {
    type: "function",
    function: {
      name: "ask_writer",
      description,
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "One short question." },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            description: "Two to four genuinely different directions.",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "A few words." },
                description: { type: "string", description: "One sentence on what it would mean. Optional." },
              },
              required: ["label"],
            },
          },
        },
        required: ["question", "options"],
      },
    },
  };
}

/** `look_at_frame`, with the guidance that fits the kind of run. */
export function lookTool(description: string) {
  return {
    type: "function",
    function: {
      name: "look_at_frame",
      description,
      parameters: {
        type: "object",
        properties: {
          time: timeParam("The moment to look at, in seconds."),
          question: {
            type: "string",
            description: "Something to look out for in particular. Optional.",
          },
        },
        required: ["time"],
      },
    },
  };
}

export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_cues",
      description:
        "Read the script between two times, anywhere in the video. Each line shows its id, timing, speaker, says/thinks, text and reading speed.",
      parameters: {
        type: "object",
        properties: {
          from: timeParam("Start, in seconds."),
          to: timeParam("End, in seconds."),
        },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_cue",
      description:
        "Add a line inside your window. Leave out `end` to time it to the target reading speed. Refused if it would overlap another line or leave your window.",
      parameters: {
        type: "object",
        properties: {
          start: timeParam("When the line appears, in seconds."),
          end: timeParam("When it disappears, in seconds. Optional."),
          speaker: { type: "string", description: "A character's name, exactly as listed." },
          mode: {
            type: "string",
            enum: ["says", "thinks"],
            description: "Spoken aloud, or private inner voice.",
          },
          text: { type: "string", description: "The line itself, without quotes or asterisks." },
        },
        required: ["start", "speaker", "mode", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_cue",
      description: "Change a line inside your window: its text, speaker, or says/thinks. Give only what changes.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The line's id, e.g. c4." },
          text: { type: "string" },
          speaker: { type: "string" },
          mode: { type: "string", enum: ["says", "thinks"] },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_cue",
      description:
        "Retime a line inside your window. Leave out `end` to keep its length. Refused if it would overlap another line or leave your window.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          start: timeParam("New start, in seconds."),
          end: timeParam("New end, in seconds. Optional."),
        },
        required: ["id", "start"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_cue",
      description: "Remove a line inside your window.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "Call once the stretch is written and checked. Ends your turn.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "One sentence for the writer on what you did." },
        },
        required: ["summary"],
      },
    },
  },
  askTool(
    `Ask the writer a multiple-choice question about general direction — where the scene goes, whose beat it is, the tone or pace — when the story could genuinely go very different ways and their direction does not settle it. Never use it to approve wording or specific lines. Ask before you write. They can also answer in their own words or leave it to you. At most ${MAX_QUESTIONS} per run.`,
  ),
];

const LOOK_TOOL = lookTool(
  `See what is on screen at a moment: a separate vision model describes that frame in words. Look where it matters — the start of your window, a new shot, before writing a reaction. Each look is slow and costs money; you have ${MAX_LOOKS} per run.`,
);

/** The tools a run gets: looking at the video only when a vision model is set. */
export function agentTools(vision: boolean): unknown[] {
  return vision ? [...AGENT_TOOLS, LOOK_TOOL] : AGENT_TOOLS;
}

export interface ToolOutcome {
  /** The same array when nothing changed. */
  cues: Cue[];
  /** What the model reads back. */
  result: string;
  /** What the chat log lists; null for a call not worth a line. */
  step: AgentStep | null;
  /** The cue an `add_cue` made. */
  created?: string;
  /** Set by `finish`: the model's closing words. */
  finished?: string;
}

export class Refusal extends Error {}

export const BAD_ARGS = "The arguments were not a JSON object.";

/** A tool call's arguments, or null when they are not a JSON object. */
export function parseArgs(rawArgs: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function refuse(message: string): never {
  throw new Refusal(message);
}

export function num(args: Record<string, unknown>, key: string, optional = false): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (optional) return undefined;
    refuse(`\`${key}\` is required.`);
  }
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) refuse(`\`${key}\` must be a number of seconds.`);
  return n;
}

export function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function lookup(cues: Cue[], aliases: Aliases, ref: unknown): Cue {
  const id = typeof ref === "string" ? aliases.byAlias.get(ref.trim()) : undefined;
  const cue = id ? cues.find((c) => c.id === id) : undefined;
  if (!cue) refuse(`There is no line "${String(ref)}". Use an id from read_cues.`);
  return cue;
}

function resolveSpeaker(env: AgentEnv, name: string | undefined): string | null {
  if (env.speakers.length === 0) return null;
  const known = env.speakers.map((s) => s.name.trim()).join(", ");
  if (!name?.trim()) refuse(`\`speaker\` is required; known: ${known}.`);
  const id = speakerIdForName(env.speakers, name);
  if (!id) refuse(`Unknown speaker "${name}"; known: ${known}.`);
  return id;
}

function resolveMode(value: string | undefined): Cue["mode"] {
  if (value === "thinks") return "thought";
  if (value === undefined || value === "says") return undefined;
  refuse(`\`mode\` must be "says" or "thinks".`);
}

/** Text as stored: one wrapped cue, without the asterisks export adds. */
function shapeText(env: AgentEnv, raw: string): string {
  const text = unwrapThought(raw) ?? raw;
  const shaped = wrapText(oneLine(text).replace(/^"(.*)"$/, "$1"), env.maxCharsPerLine, env.maxLines);
  if (!shaped) refuse("`text` is empty.");
  return shaped;
}

function checkSpan(env: AgentEnv, cues: Cue[], aliases: Aliases, start: number, end: number, self?: string) {
  if (!inWindow(env, start, end)) {
    refuse(`${span(start, end)} is outside your window ${windowLabel(env)}.`);
  }
  if (end - start < MIN_CUE_DURATION - EPSILON) {
    refuse(`A line must last at least ${MIN_CUE_DURATION} s.`);
  }
  const clash = cues.find(
    (c) => c.id !== self && start < c.end + env.minGap - EPSILON && c.start < end + env.minGap - EPSILON,
  );
  if (clash) {
    refuse(
      `${span(start, end)} overlaps ${aliasFor(aliases, clash.id)} [${span(clash.start, clash.end)}]; lines need ${env.minGap} s between them.`,
    );
  }
}

function checkEditable(env: AgentEnv, cue: Cue, aliases: Aliases) {
  if (!inWindow(env, cue.start, cue.end)) {
    refuse(`${aliasFor(aliases, cue.id)} is outside your window ${windowLabel(env)}; you can only read it.`);
  }
}

/** Where a line starting at `start` must end to leave room for the next one. */
function roomAfter(env: AgentEnv, cues: Cue[], start: number): number {
  const next = sortCues(cues).find((c) => c.start >= start - EPSILON);
  return Math.min(env.window.end, next ? next.start - env.minGap : Infinity);
}

function replace(cues: Cue[], next: Cue): Cue[] {
  return sortCues(cues.map((c) => (c.id === next.id ? next : c)));
}

function shortText(text: string): string {
  const line = oneLine(text);
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}

/**
 * Runs one tool call against `cues`. Never throws: a bad call comes back as an
 * error the model reads and can correct.
 */
export function executeTool(
  cues: Cue[],
  env: AgentEnv,
  aliases: Aliases,
  name: string,
  rawArgs: string,
): ToolOutcome {
  const args = parseArgs(rawArgs);
  if (!args) return failure(cues, name, BAD_ARGS);
  try {
    return runTool(cues, env, aliases, name, args);
  } catch (e) {
    if (e instanceof Refusal) return failure(cues, name, e.message);
    throw e;
  }
}

function failure(cues: Cue[], name: string, message: string): ToolOutcome {
  return { cues, result: `Error: ${message}`, step: { kind: "error", label: `${name}: ${message}` } };
}

function runTool(
  cues: Cue[],
  env: AgentEnv,
  aliases: Aliases,
  name: string,
  args: Record<string, unknown>,
): ToolOutcome {
  switch (name) {
    case "read_cues": {
      const from = num(args, "from")!;
      const to = num(args, "to")!;
      if (to <= from) refuse("`to` must be after `from`.");
      const found = cuesBetween(cues, from, to);
      const shown = found.slice(0, READ_LIMIT);
      const more = found.length - shown.length;
      const body = shown.length > 0 ? renderLines(shown, env, aliases) : "(no lines)";
      return {
        cues,
        result: more > 0 ? `${body}\n(${more} more lines; read a shorter stretch)` : body,
        step: { kind: "read", label: `Read ${span(from, to)}` },
      };
    }

    case "add_cue": {
      const start = num(args, "start")!;
      const mode = resolveMode(str(args, "mode"));
      const speakerId = resolveSpeaker(env, str(args, "speaker"));
      const text = shapeText(env, str(args, "text") ?? "");
      let end = num(args, "end", true);
      if (end === undefined) {
        // Timed to the text, but cut to the room there is; the reading speed
        // in the result says whether that was enough.
        end = Math.min(start + durationForText(text, env.targetCps), roomAfter(env, cues, start));
      }
      checkSpan(env, cues, aliases, start, end);
      const cue: Cue = { ...newCue(start, end, speakerId, mode), text };
      return {
        cues: sortCues([...cues, cue]),
        result: `Added ${renderCue(cue, env, aliases)}`,
        step: {
          kind: "add",
          label: `＋ ${speakerName(env.speakers, speakerId)}: “${shortText(text)}” · ${formatShort(start)}`,
        },
        created: cue.id,
      };
    }

    case "edit_cue": {
      const cue = lookup(cues, aliases, args.id);
      checkEditable(env, cue, aliases);
      const next: Cue = { ...cue };
      const text = str(args, "text");
      const speaker = str(args, "speaker");
      const mode = str(args, "mode");
      if (text === undefined && speaker === undefined && mode === undefined) {
        refuse("Give at least one of `text`, `speaker`, `mode`.");
      }
      if (text !== undefined) next.text = shapeText(env, text);
      if (speaker !== undefined) next.speakerId = resolveSpeaker(env, speaker);
      if (mode !== undefined) {
        const resolved = resolveMode(mode);
        if (resolved) next.mode = resolved;
        else delete next.mode;
      }
      return {
        cues: replace(cues, next),
        result: `Now ${renderCue(next, env, aliases)}`,
        step: { kind: "edit", label: `✎ ${aliasFor(aliases, cue.id)} “${shortText(next.text)}”` },
      };
    }

    case "move_cue": {
      const cue = lookup(cues, aliases, args.id);
      checkEditable(env, cue, aliases);
      const start = num(args, "start")!;
      const end = num(args, "end", true) ?? start + (cue.end - cue.start);
      checkSpan(env, cues, aliases, start, end, cue.id);
      const next = { ...cue, start, end };
      return {
        cues: replace(cues, next),
        result: `Moved: ${renderCue(next, env, aliases)}`,
        step: { kind: "move", label: `↔ ${aliasFor(aliases, cue.id)} → ${span(start, end)}` },
      };
    }

    case "delete_cue": {
      const cue = lookup(cues, aliases, args.id);
      checkEditable(env, cue, aliases);
      const alias = aliasFor(aliases, cue.id);
      return {
        cues: cues.filter((c) => c.id !== cue.id),
        result: `Deleted ${alias}.`,
        step: { kind: "delete", label: `✕ ${alias} “${shortText(cue.text)}”` },
      };
    }

    case "finish": {
      const summary = oneLine(str(args, "summary") ?? "");
      return { cues, result: "Finished.", step: null, finished: summary };
    }

    default:
      return refuse(`There is no tool "${name}".`);
  }
}

// --- Looking at the video ------------------------------------------------------

/** What a run has had described so far, by time rounded to a tenth. */
export interface Looks {
  seen: Map<string, string>;
  /** Calls made, whether or not they worked. */
  used: number;
}

export function createLooks(): Looks {
  return { seen: new Map(), used: 0 };
}

/** What to do about a `look_at_frame` call. */
export type LookPlan =
  | { kind: "fetch"; time: number; key: string; question?: string }
  | { kind: "seen"; time: number; description: string }
  | { kind: "refused"; message: string };

export function prepareLook(
  env: Pick<AgentEnv, "vision" | "duration">,
  looks: Looks,
  rawArgs: string,
  max = MAX_LOOKS,
): LookPlan {
  const args = parseArgs(rawArgs);
  if (!args) return { kind: "refused", message: BAD_ARGS };
  try {
    if (!env.vision) refuse("Looking at frames is not available in this run.");
    const time = num(args, "time")!;
    if (time < 0 || (env.duration > 0 && time >= env.duration)) {
      refuse(`${formatShort(time)} is not in the video${env.duration > 0 ? ` (0:00.00–${formatShort(env.duration)})` : ""}.`);
    }
    const key = time.toFixed(1);
    const seen = looks.seen.get(key);
    if (seen !== undefined) return { kind: "seen", time, description: seen };
    if (looks.used >= max) {
      refuse(`You have used all ${max} looks for this run. Carry on from the script.`);
    }
    const question = str(args, "question")?.trim();
    return { kind: "fetch", time, key, ...(question ? { question } : {}) };
  } catch (e) {
    if (e instanceof Refusal) return { kind: "refused", message: e.message };
    throw e;
  }
}

/** A description as the run reads it: clearly a second-hand, fallible hint. */
export function lookResult(time: number, description: string): string {
  return `Vision model's description of the frame at ${formatShort(time)} (a hint: it can be wrong, and the script and the writer's notes win):\n${description}`;
}

/**
 * A frame described in words, or why not. Rejects only when the run is
 * stopped; a failed or refused look is an answer the run carries on from.
 */
export type DescribeFrame = (
  time: number,
  question?: string,
) => Promise<{ ok: true; description: string } | { ok: false; error: string }>;

export async function look(
  env: Pick<AgentEnv, "vision" | "duration">,
  looks: Looks,
  rawArgs: string,
  describe: DescribeFrame | undefined,
  max = MAX_LOOKS,
): Promise<{ result: string; step: AgentStep }> {
  const plan = describe
    ? prepareLook(env, looks, rawArgs, max)
    : ({ kind: "refused", message: "Looking at frames is not available in this run." } as const);
  const label = (time: number) => `👁 Looked at ${formatShort(time)}`;
  switch (plan.kind) {
    case "refused":
      return {
        result: `Error: ${plan.message}`,
        step: { kind: "error", label: `look_at_frame: ${plan.message}` },
      };
    case "seen":
      return {
        result: lookResult(plan.time, plan.description),
        step: { kind: "look", label: label(plan.time), detail: plan.description },
      };
    case "fetch": {
      looks.used++;
      const answer = await describe!(plan.time, plan.question);
      if (!answer.ok) {
        return {
          result: `Error: the vision model could not describe the frame (${answer.error}). Carry on from the script.`,
          step: { kind: "error", label: `look_at_frame: ${answer.error}` },
        };
      }
      looks.seen.set(plan.key, answer.description);
      return {
        result: lookResult(plan.time, answer.description),
        step: { kind: "look", label: label(plan.time), detail: answer.description },
      };
    }
  }
}

// --- Asking the writer -----------------------------------------------------------

/** The writer's answer to a question, or why there is none. Rejects on Stop. */
export type AskWriter = (question: WriterQuestion) => Promise<WriterAnswer>;

const clip = (text: string, max: number) => {
  const line = oneLine(text);
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** A well-formed question within the run's budget, or why not. */
export function prepareQuestion(
  asked: number,
  rawArgs: string,
  max = MAX_QUESTIONS,
): { ok: true; question: WriterQuestion } | { ok: false; message: string } {
  const args = parseArgs(rawArgs);
  if (!args) return { ok: false, message: BAD_ARGS };
  if (asked >= max) {
    return { ok: false, message: `You have asked ${max} questions; decide the rest yourself.` };
  }
  const question = clip(str(args, "question") ?? "", QUESTION_CHARS);
  if (!question) return { ok: false, message: "`question` is empty." };
  const raw = Array.isArray(args.options) ? args.options : [];
  const options = raw
    .map((o) => {
      const option = typeof o === "string" ? { label: o } : (o as Record<string, unknown>);
      const label = clip(typeof option?.label === "string" ? option.label : "", LABEL_CHARS);
      const description = clip(typeof option?.description === "string" ? option.description : "", QUESTION_CHARS);
      return description ? { label, description } : { label };
    })
    .filter((o) => o.label);
  if (options.length < 2 || options.length > 4) {
    return { ok: false, message: "Give two to four options, each with a `label`." };
  }
  const labels = new Set(options.map((o) => o.label.toLowerCase()));
  if (labels.size !== options.length) return { ok: false, message: "Each option needs its own label." };
  return { ok: true, question: { question, options } };
}

function answerResult(answer: WriterAnswer): { result: string; detail: string } {
  switch (answer.kind) {
    case "option":
      return { result: `The writer chose: "${answer.label}".`, detail: `→ ${answer.label}` };
    case "own":
      return {
        result: `The writer answered in their own words: "${oneLine(answer.text)}"`,
        detail: `→ “${oneLine(answer.text)}”`,
      };
    case "skipped":
      return {
        result: "The writer skipped the question — decide yourself, and don't ask again about this.",
        detail: "→ skipped: left to the model",
      };
  }
}

export async function ask(
  asked: { count: number },
  rawArgs: string,
  askWriter: AskWriter | undefined,
  max = MAX_QUESTIONS,
): Promise<{ result: string; step: AgentStep }> {
  const prepared = askWriter
    ? prepareQuestion(asked.count, rawArgs, max)
    : ({ ok: false, message: "The writer cannot be asked in this run; decide yourself." } as const);
  if (!prepared.ok) {
    return {
      result: `Error: ${prepared.message}`,
      step: { kind: "error", label: `ask_writer: ${prepared.message}` },
    };
  }
  asked.count++;
  const answer = await askWriter!(prepared.question);
  const { result, detail } = answerResult(answer);
  return { result, step: { kind: "ask", label: `❓ ${prepared.question.question}`, detail } };
}

// --- Prompt ------------------------------------------------------------------

const AGENT_SYSTEM_PROMPT = `You are writing the next stretch of a subtitled video's script yourself, directly into the timeline, using the tools you have. The writer handed you a window of time; fill it with dialogue and inner thoughts that belong in this story.

How to work
- Read before you write: the lines before your window are in the first message; call read_cues for more context when you need it.
- Write the lines with add_cue, in order. Leave natural pauses; a scene need not fill every second.
- Then read your window back once and fix what reads badly: a line marked "too fast" needs fewer words or more time, a beat that lands flat needs a rewrite.
- Lines already in your window are part of the script. Keep them unless the writer's direction says otherwise or they no longer fit what you wrote.
- Call finish with one sentence for the writer when you are done.

Asking the writer
- Mostly, just write: the writer handed this to you. ask_writer is for when the direction is genuinely open — they gave little or no direction, and the script and beats allow very different paths.
- Never ask when the direction from the writer already settles it, and never ask about specific lines or wording: they can change any line themselves afterwards.
- Ask before you write, not after. Offer options that are truly different directions, not variations of one.
- If the writer skips a question, decide yourself and don't ask again about it.

The rules your tools enforce
- You can only change lines inside your window. Lines marked "outside window" are read-only.
- Lines may not overlap, and need a short gap between them.
- "says" is spoken aloud; "thinks" is private inner voice nobody else hears.

Reading the script
- Lines are "c4 [1:21.40–1:23.10] Name says: text (16 cps)". The id (c4) is how you refer to a line; times are minutes:seconds, but every tool takes plain seconds (1:21.40 is 81.4).
- "(pause 4.2s)" marks a silence; "== Scene: name ==" marks where a section of the video begins.
- Write in the language and voice of the script.`;

export const LOOKING_PROMPT = `## Looking at the video
look_at_frame has a separate vision model describe what is on screen at a moment. Use it to fit your lines to the picture: the setting, who is in shot, what they are doing, the mood.
- Treat every description as a hint, not fact. Vision models miss things, mix people up and sometimes invent details, and they never know who anyone is.
- The script, the brief, the scene notes and the writer's direction always win. Never write a line that contradicts them because of a description.
- Match a person in the description to a character only when the script makes it clear who is in the scene; otherwise write as if you had not seen them.
- If a look fails or the vision model refuses to describe the frame, do not ask for the same frame again. Carry on from the script.`;

export function buildContinueSystemPrompt(
  context: { brief: string; beats: string[] },
  env: AgentEnv,
): string {
  const limits = [
    "## Limits",
    `- Aim for ${env.targetCps} characters per second or slower; above ${CPS_WARNING} is too fast to read.`,
    `- At most ${env.maxLines} lines of ${env.maxCharsPerLine} characters on screen; longer text is wrapped for you, but keep it short.`,
    `- ${env.minGap} s between lines; at least ${MIN_CUE_DURATION} s per line.`,
  ].join("\n");
  const parts = [AGENT_SYSTEM_PROMPT, limits];
  if (env.vision) parts.push(LOOKING_PROMPT);
  parts.push(...renderProjectContext({ ...context, speakers: env.speakers }));
  const scene = renderCurrentScene(env.sections, env.window.start);
  if (scene) parts.push(scene);
  return parts.join("\n\n");
}

/** The opening message of a run: the window, the script around it, the brief. */
export function buildContinueKickoff(
  cues: Cue[],
  env: AgentEnv,
  aliases: Aliases,
  direction: string,
  linesBefore: number,
  timedBeats: TimedBeat[] = [],
): string {
  const sorted = sortCues(cues);
  const { start, end } = env.window;
  const before = sorted.filter((c) => c.end <= start + EPSILON).slice(-Math.max(1, linesBefore));
  const inside = sorted.filter((c) => c.end > start + EPSILON && c.start < end - EPSILON);
  const after = sorted.filter((c) => c.start >= end - EPSILON).slice(0, LINES_AFTER);
  const planned = [...beatsBetween(timedBeats, start, end), ...beatsBetween(timedBeats, end, Infinity).slice(0, BEATS_AFTER)];

  const parts = [
    `## Your window\n${windowLabel(env)} — ${start.toFixed(2)} s to ${end.toFixed(2)} s, ${(end - start).toFixed(1)} s long.`,
    `## Script before your window\n${before.length > 0 ? renderLines(before, env, aliases) : "(nothing yet — this is the start)"}`,
    `## Already in your window\n${inside.length > 0 ? renderLines(inside, env, aliases) : "(empty)"}`,
  ];
  if (after.length > 0) {
    parts.push(`## Right after your window (lead into this)\n${renderLines(after, env, aliases)}`);
  }
  if (planned.length > 0) {
    parts.push(
      `## Planned story beats\nWhere the story is meant to go. A beat inside your window should happen there, around its time; later ones are where the scene is heading.\n${renderTimedBeats(planned)}`,
    );
  }
  parts.push(
    `## Direction from the writer\n${direction.trim() || "None — continue the scene the way the story wants it to go."}`,
  );
  return parts.join("\n\n");
}

export function buildAgentRequest(
  messages: AgentMessage[],
  settings: { model: string; temperature: number; effort?: ChatEffort | null },
  tools: unknown[] = AGENT_TOOLS,
): AgentRequest {
  const effort = settings.effort ?? null;
  return {
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: effort ? AGENT_MAX_TOKENS_REASONING : AGENT_MAX_TOKENS,
    messages,
    tools,
    ...(effort ? { reasoningEffort: effort } : {}),
  };
}

// --- The run -----------------------------------------------------------------

export interface AgentDeps {
  /** One model turn. Rejects when the run is stopped. */
  send: (messages: AgentMessage[]) => Promise<AgentReply>;
  /** The script as it is now — the writer may edit while the run works. */
  getCues: () => Cue[];
  applyCues: (cues: Cue[]) => void;
  onStep: (step: AgentStep) => void;
  /** False once the run has been reset or replaced; nothing more may land. */
  isCurrent: () => boolean;
  /** Describes a frame; absent when the run cannot look at the video. */
  describeFrame?: DescribeFrame;
  /** Puts a question to the writer; absent when nobody can answer. */
  askWriter?: AskWriter;
}

export interface AgentResult {
  ending: "finished" | "limit" | "abandoned";
  summary: string;
  /** Cues the run added, in the order it added them. */
  created: string[];
}

/** What one tool call comes to: what the model reads back, and the log line. */
export interface CallOutcome {
  result: string;
  step: AgentStep | null;
  /** Set by `finish`: the model's closing words. */
  finished?: string;
}

export interface ToolLoopDeps {
  send: AgentDeps["send"];
  onStep: AgentDeps["onStep"];
  isCurrent: AgentDeps["isCurrent"];
  /** Runs one call — applying whatever it changes — and says how it went. */
  execute: (name: string, rawArgs: string) => CallOutcome | Promise<CallOutcome>;
}

/**
 * The loop every kind of run shares: send the conversation, run the tool calls
 * that come back, feed their results in, until the model calls `finish`,
 * replies without a tool call, or runs out of turns.
 */
export async function runToolLoop(
  messages: AgentMessage[],
  deps: ToolLoopDeps,
  maxSteps: number,
): Promise<Omit<AgentResult, "created">> {
  const conversation = [...messages];
  for (let turn = 0; turn < maxSteps; turn++) {
    if (!deps.isCurrent()) return { ending: "abandoned", summary: "" };
    const reply = await deps.send(conversation);
    if (!deps.isCurrent()) return { ending: "abandoned", summary: "" };
    conversation.push(reply);

    const calls = reply.tool_calls ?? [];
    if (calls.length === 0) return { ending: "finished", summary: oneLine(reply.content ?? "") };

    let finished: string | null = null;
    for (const call of calls) {
      const done = await deps.execute(call.function.name, call.function.arguments);
      // A look or a question can take a while; the run may be gone by now.
      if (!deps.isCurrent()) return { ending: "abandoned", summary: "" };
      if (done.step) deps.onStep(done.step);
      if (done.finished !== undefined) finished = done.finished;
      conversation.push({ role: "tool", tool_call_id: call.id, content: done.result });
    }
    if (finished !== null) return { ending: "finished", summary: finished };
  }
  return { ending: "limit", summary: `Stopped after ${maxSteps} turns.` };
}

/**
 * Turns the model loose on `messages` until it calls `finish`, replies without
 * a tool call, or runs out of turns.
 */
export async function runAgent(
  messages: AgentMessage[],
  env: AgentEnv,
  aliases: Aliases,
  deps: AgentDeps,
  maxSteps = MAX_AGENT_STEPS,
): Promise<AgentResult> {
  const created: string[] = [];
  const looks = createLooks();
  const asked = { count: 0 };

  const result = await runToolLoop(
    messages,
    {
      send: deps.send,
      onStep: deps.onStep,
      isCurrent: deps.isCurrent,
      execute: (name, rawArgs) => {
        if (name === "look_at_frame") return look(env, looks, rawArgs, deps.describeFrame);
        if (name === "ask_writer") return ask(asked, rawArgs, deps.askWriter);
        const current = deps.getCues();
        const outcome = executeTool(current, env, aliases, name, rawArgs);
        if (outcome.cues !== current) deps.applyCues(outcome.cues);
        if (outcome.created) created.push(outcome.created);
        return outcome;
      },
    },
    maxSteps,
  );
  return { ...result, created };
}

/**
 * What the conversation remembers of a run, and what its bubble ends with:
 * `Continued 1:20.00–1:50.00: added 6, edited 1. Ben admits it.`
 */
export function describeRun(run: AgentRun): string {
  const counts: Array<[AgentStep["kind"], string]> = [
    ["add", "added"],
    ["edit", "edited"],
    ["move", "moved"],
    ["delete", "deleted"],
  ];
  const did = counts
    .map(([kind, verb]) => [verb, run.steps.filter((s) => s.kind === kind).length] as const)
    .filter(([, n]) => n > 0)
    .map(([verb, n]) => `${verb} ${n}`);
  const looked = run.steps.filter((s) => s.kind === "look").length;
  if (looked > 0) did.push(`looked at ${looked} ${looked === 1 ? "frame" : "frames"}`);
  const questions = run.steps.filter((s) => s.kind === "ask").length;
  if (questions > 0) did.push(`asked ${questions} ${questions === 1 ? "question" : "questions"}`);
  const head = `Continued ${span(run.from, run.to)}: ${did.length > 0 ? did.join(", ") : "no changes"}.`;
  return run.summary ? `${head} ${run.summary}` : head;
}
