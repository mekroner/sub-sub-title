/**
 * `/story`: the chat model works on the outline — section names and notes,
 * timed story beats, the overall beats — so `/continue`, Fill and the chat know
 * where the story is going. It reads the script, looks at frames, asks the
 * writer about the big forks, and looks for an arc that fits what is already
 * on screen. It never touches the subtitle lines.
 *
 * The writer's own beats are fixed points: the run builds around them, and may
 * only revise or remove the beats it wrote itself. Like `agent.ts`, the tools
 * refuse rather than quietly adjust, so the model learns where it went wrong.
 */

import type {
  AgentMessage,
  AgentReply,
  AgentRun,
  AgentStep,
  Cue,
  Section,
  Speaker,
  TimedBeat,
} from "../types";
import {
  BAD_ARGS,
  LOOKING_PROMPT,
  Refusal,
  aliasFor,
  ask,
  askTool,
  createLooks,
  cuesBetween,
  look,
  lookTool,
  num,
  oneLine,
  parseArgs,
  refuse,
  renderLines,
  str,
  timeParam,
  type AgentEnv,
  type Aliases,
  type AskWriter,
  type CallOutcome,
  type DescribeFrame,
  runToolLoop,
  createAliases,
} from "./agent";
import { renderProjectContext } from "./fill";
import { insertSection, newSection, renameSection, setSectionNote, sortSections } from "./sections";
import { addBeat, editBeat, groupBySection, newBeat, removeBeat } from "./timedBeats";
import { DEFAULT_TARGET_CPS, formatShort } from "./time";

/** Model turns a story run may take: it reads a lot before it writes. */
export const MAX_STORY_STEPS = 60;
export const MAX_STORY_QUESTIONS = 8;
export const MAX_STORY_LOOKS = 12;
/** No new section this close to an existing flag: it is the same cut. */
const SECTION_MIN_GAP = 2;
const MAX_OVERALL_BEATS = 12;
const BEAT_CHARS = 240;
const NOTE_CHARS = 600;
const LABEL_CHARS = 60;
/** Most script lines one `read_cues` returns. */
const READ_LIMIT = 150;

const EPSILON = 1e-6;

// --- The command ------------------------------------------------------------

/** `/story`, `/story make it a revenge story` — or null for any other message. */
export function parseStoryCommand(text: string): { direction: string } | null {
  const match = /^\/story(?:\s+|$)(.*)$/is.exec(text.trim());
  return match ? { direction: match[1].trim() } : null;
}

// --- The run's world --------------------------------------------------------

/** The part of the project a story run may change. */
export interface StoryState {
  sections: Section[];
  beats: string[];
  timedBeats: TimedBeat[];
}

export interface StoryEnv {
  /** Seconds; 0 when unknown. */
  duration: number;
  vision: boolean;
  speakers: Speaker[];
}

/** Short names for the run: `s1` for sections, `b1` for beats, `c1` for lines. */
export interface StoryAliases {
  sections: Aliases;
  beats: Aliases;
  cues: Aliases;
}

export function createStoryAliases(): StoryAliases {
  return { sections: createAliases("s"), beats: createAliases("b"), cues: createAliases("c") };
}

const span = (start: number, end: number) => `${formatShort(start)}–${formatShort(end)}`;

const clip = (text: string, max: number) => {
  const line = oneLine(text);
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

function inVideo(env: StoryEnv, time: number): boolean {
  return time >= 0 && (env.duration <= 0 || time < env.duration);
}

function checkTime(env: StoryEnv, time: number) {
  if (!inVideo(env, time)) {
    refuse(`${formatShort(time)} is not in the video${env.duration > 0 ? ` (0:00.00–${formatShort(env.duration)})` : ""}.`);
  }
}

function lookup<T extends { id: string }>(items: T[], aliases: Aliases, ref: unknown, noun: string): T {
  const id = typeof ref === "string" ? aliases.byAlias.get(ref.trim()) : undefined;
  const item = id ? items.find((i) => i.id === id) : undefined;
  if (!item) refuse(`There is no ${noun} "${String(ref)}". Use an id from read_outline.`);
  return item;
}

function renderBeat(beat: TimedBeat, aliases: StoryAliases): string {
  const owner = beat.by === "agent" ? "yours" : "writer's — fixed";
  return `${aliasFor(aliases.beats, beat.id)} [${formatShort(beat.time)}] ${oneLine(beat.text) || "…"} (${owner})`;
}

/**
 * The whole outline as the model reads it: every section with its span, note,
 * script line count and beats, then the overall beats.
 */
export function renderOutline(state: StoryState, cues: Cue[], env: StoryEnv, aliases: StoryAliases): string {
  const groups = groupBySection(state.sections, state.timedBeats, env.duration);
  const out: string[] = [env.duration > 0 ? `Video length: ${formatShort(env.duration)}` : "Video length: unknown"];
  for (const group of groups) {
    const lines = cues.filter((c) => c.start >= group.start - EPSILON && c.start < group.end - EPSILON).length;
    const count = `${lines} ${lines === 1 ? "line" : "lines"} of script`;
    if (group.section) {
      const label = oneLine(group.section.label) || "untitled";
      out.push(`${aliasFor(aliases.sections, group.section.id)} [${span(group.start, group.end)}] "${label}" — ${count}`);
      const note = oneLine(group.section.note ?? "");
      out.push(note ? `   Note: ${note}` : "   Note: (none)");
    } else {
      out.push(`Before any section [${span(group.start, group.end)}] — ${count}`);
    }
    if (group.beats.length === 0) out.push("   (no beats)");
    for (const beat of group.beats) out.push(`   ${renderBeat(beat, aliases)}`);
  }
  const overall = state.beats.map((b) => b.trim()).filter(Boolean);
  out.push("", "Overall story beats:");
  out.push(overall.length > 0 ? overall.map((b, i) => `${i + 1}. ${b}`).join("\n") : "(none yet)");
  return out.join("\n");
}

/** `renderLines` needs a /continue world; a story run reads everything, editable or not. */
function readingEnv(state: StoryState, env: StoryEnv): AgentEnv {
  return {
    window: { start: 0, end: Infinity },
    duration: env.duration,
    vision: env.vision,
    speakers: env.speakers,
    sections: state.sections,
    targetCps: DEFAULT_TARGET_CPS,
    minGap: 0,
    maxCharsPerLine: 42,
    maxLines: 2,
  };
}

// --- Tools -------------------------------------------------------------------

const idParam = (description: string) => ({ type: "string", description });

export const STORY_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_outline",
      description: "Read the whole outline as it stands now: sections, notes, timed beats and the overall beats.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_cues",
      description: `Read the script between two times. Read section by section; at most ${READ_LIMIT} lines come back at once.`,
      parameters: {
        type: "object",
        properties: { from: timeParam("Start, in seconds."), to: timeParam("End, in seconds.") },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_section",
      description: "Rename a section, or write its note: who wants what here, and what changes. /continue and Fill read the note.",
      parameters: {
        type: "object",
        properties: {
          id: idParam("The section's id, e.g. s2."),
          label: { type: "string", description: "A short scene name." },
          note: { type: "string", description: "Two or three sentences." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_section",
      description: "Flag a new section where a scene clearly starts and none is flagged yet.",
      parameters: {
        type: "object",
        properties: {
          start: timeParam("Where the scene starts, in seconds."),
          label: { type: "string" },
          note: { type: "string" },
        },
        required: ["start", "label"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_beat",
      description:
        "Pin a story beat to the moment it happens — or, where there is no script yet, the moment it should happen. One sentence.",
      parameters: {
        type: "object",
        properties: { time: timeParam("The moment, in seconds."), text: { type: "string" } },
        required: ["time", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_beat",
      description: "Revise one of your own beats: its moment or its text. The writer's beats are fixed.",
      parameters: {
        type: "object",
        properties: { id: idParam("The beat's id, e.g. b3."), time: timeParam("New moment, in seconds."), text: { type: "string" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_beat",
      description: "Remove one of your own beats. The writer's beats are fixed.",
      parameters: { type: "object", properties: { id: idParam("The beat's id.") }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "set_story_beats",
      description: `Replace the overall story beats: the whole arc in ${MAX_OVERALL_BEATS} sentences or fewer, in story order.`,
      parameters: {
        type: "object",
        properties: { beats: { type: "array", items: { type: "string" } } },
        required: ["beats"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "Call once the outline is in shape. Ends your turn.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string", description: "One or two sentences for the writer: the arc you found." } },
        required: ["summary"],
      },
    },
  },
  askTool(
    `Ask the writer a multiple-choice question about the story: what it is about, where it should end up, what a character wants or hides, the tone, which of two arcs to follow. Ask early, about the big forks, before you commit beats; offer concrete options grounded in what is on screen. Never about the wording of lines. They can also answer in their own words or leave it to you. You have ${MAX_STORY_QUESTIONS} per run — use what you need.`,
  ),
];

const STORY_LOOK_TOOL = lookTool(
  `See what is on screen at a moment: a separate vision model describes that frame in words. Look at the opening of each scene and at turning points, to learn the setting, who is there and the mood. Each look is slow and costs money; you have ${MAX_STORY_LOOKS} per run.`,
);

/** The tools a story run gets: looking at the video only when a vision model is set. */
export function storyTools(vision: boolean): unknown[] {
  return vision ? [...STORY_TOOLS, STORY_LOOK_TOOL] : STORY_TOOLS;
}

export interface StoryOutcome extends CallOutcome {
  /** The same object when nothing changed. */
  state: StoryState;
}

function fail(state: StoryState, name: string, message: string): StoryOutcome {
  return { state, result: `Error: ${message}`, step: { kind: "error", label: `${name}: ${message}` } };
}

/**
 * Runs one outline tool against `state`. Never throws: a bad call comes back as
 * an error the model reads and can correct.
 */
export function executeStoryTool(
  state: StoryState,
  cues: Cue[],
  env: StoryEnv,
  aliases: StoryAliases,
  name: string,
  rawArgs: string,
): StoryOutcome {
  const args = parseArgs(rawArgs);
  if (!args) return fail(state, name, BAD_ARGS);
  try {
    return runStoryTool(state, cues, env, aliases, name, args);
  } catch (e) {
    if (e instanceof Refusal) return fail(state, name, e.message);
    throw e;
  }
}

function runStoryTool(
  state: StoryState,
  cues: Cue[],
  env: StoryEnv,
  aliases: StoryAliases,
  name: string,
  args: Record<string, unknown>,
): StoryOutcome {
  switch (name) {
    case "read_outline":
      return { state, result: renderOutline(state, cues, env, aliases), step: { kind: "read", label: "Read the outline" } };

    case "read_cues": {
      const from = num(args, "from")!;
      const to = num(args, "to")!;
      if (to <= from) refuse("`to` must be after `from`.");
      const found = cuesBetween(cues, from, to);
      const shown = found.slice(0, READ_LIMIT);
      const more = found.length - shown.length;
      const body = shown.length > 0 ? renderLines(shown, readingEnv(state, env), aliases.cues) : "(no lines)";
      return {
        state,
        result: more > 0 ? `${body}\n(${more} more lines; read a shorter stretch)` : body,
        step: { kind: "read", label: `Read ${span(from, to)}` },
      };
    }

    case "set_section": {
      const section = lookup(state.sections, aliases.sections, args.id, "section");
      const label = str(args, "label");
      const note = str(args, "note");
      if (label === undefined && note === undefined) refuse("Give `label`, `note`, or both.");
      let sections = state.sections;
      if (label !== undefined) {
        const clipped = clip(label, LABEL_CHARS);
        if (!clipped) refuse("`label` is empty.");
        sections = renameSection(sections, section.id, clipped);
      }
      if (note !== undefined) sections = setSectionNote(sections, section.id, clip(note, NOTE_CHARS));
      const alias = aliasFor(aliases.sections, section.id);
      const now = sections.find((s) => s.id === section.id)!;
      return {
        state: sections === state.sections ? state : { ...state, sections },
        result: `Now ${alias} "${now.label}"${now.note ? ` — Note: ${now.note}` : ""}`,
        step: {
          kind: "section",
          label: `§ ${now.label || alias}${note !== undefined ? ": note" : ""}`,
          ...(note !== undefined && now.note ? { detail: now.note } : {}),
        },
      };
    }

    case "add_section": {
      const start = num(args, "start")!;
      checkTime(env, start);
      const label = clip(str(args, "label") ?? "", LABEL_CHARS);
      if (!label) refuse("`label` is empty.");
      const near = state.sections.find((s) => Math.abs(s.start - start) < SECTION_MIN_GAP);
      if (near) {
        refuse(`${aliasFor(aliases.sections, near.id)} already starts at ${formatShort(near.start)}; set its label and note instead.`);
      }
      const note = clip(str(args, "note") ?? "", NOTE_CHARS);
      const section: Section = { ...newSection(state.sections, start), label, ...(note ? { note } : {}) };
      const sections = insertSection(state.sections, section, env.duration > 0 ? env.duration : Infinity);
      const alias = aliasFor(aliases.sections, section.id);
      return {
        state: { ...state, sections },
        result: `Added ${alias} at ${formatShort(start)} "${label}".`,
        step: { kind: "section", label: `§ New section “${label}” · ${formatShort(start)}`, ...(note ? { detail: note } : {}) },
      };
    }

    case "add_beat": {
      const time = num(args, "time")!;
      checkTime(env, time);
      const text = clip(str(args, "text") ?? "", BEAT_CHARS);
      if (!text) refuse("`text` is empty.");
      const twin = state.timedBeats.find(
        (b) => Math.abs(b.time - time) < 1 && oneLine(b.text).toLowerCase() === text.toLowerCase(),
      );
      if (twin) refuse(`${aliasFor(aliases.beats, twin.id)} already says that at ${formatShort(twin.time)}.`);
      const beat = newBeat(time, text, "agent");
      return {
        state: { ...state, timedBeats: addBeat(state.timedBeats, beat) },
        result: `Added ${renderBeat(beat, aliases)}`,
        step: { kind: "add", label: `◆ ${formatShort(time)} ${text}` },
      };
    }

    case "edit_beat":
    case "remove_beat": {
      const beat = lookup(state.timedBeats, aliases.beats, args.id, "beat");
      const alias = aliasFor(aliases.beats, beat.id);
      if (beat.by !== "agent") {
        refuse(`${alias} is the writer's — a fixed point. Ask them if you think it should change.`);
      }
      if (name === "remove_beat") {
        return {
          state: { ...state, timedBeats: removeBeat(state.timedBeats, beat.id) },
          result: `Removed ${alias}.`,
          step: { kind: "delete", label: `✕ ${formatShort(beat.time)} ${clip(beat.text, 60)}` },
        };
      }
      const time = num(args, "time", true);
      const rawText = str(args, "text");
      if (time === undefined && rawText === undefined) refuse("Give `time`, `text`, or both.");
      if (time !== undefined) checkTime(env, time);
      const text = rawText === undefined ? undefined : clip(rawText, BEAT_CHARS);
      if (text === "") refuse("`text` is empty.");
      const timedBeats = editBeat(state.timedBeats, beat.id, { time, text }, "agent");
      const now = timedBeats.find((b) => b.id === beat.id)!;
      return {
        state: { ...state, timedBeats },
        result: `Now ${renderBeat(now, aliases)}`,
        step: { kind: "edit", label: `✎ ${formatShort(now.time)} ${clip(now.text, 60)}` },
      };
    }

    case "set_story_beats": {
      const raw = Array.isArray(args.beats) ? args.beats : [];
      const beats = raw.map((b) => (typeof b === "string" ? clip(b, BEAT_CHARS) : "")).filter(Boolean);
      if (beats.length === 0 || beats.length > MAX_OVERALL_BEATS) {
        refuse(`Give 1–${MAX_OVERALL_BEATS} beats, each one sentence.`);
      }
      return {
        state: { ...state, beats },
        result: `The overall beats are now:\n${beats.map((b, i) => `${i + 1}. ${b}`).join("\n")}`,
        step: { kind: "outline", label: `☰ Overall beats (${beats.length})`, detail: beats.map((b, i) => `${i + 1}. ${b}`).join("\n") },
      };
    }

    case "finish":
      return { state, result: "Finished.", step: null, finished: oneLine(str(args, "summary") ?? "") };

    default:
      return refuse(`There is no tool "${name}".`);
  }
}

// --- Prompt ------------------------------------------------------------------

const STORY_SYSTEM_PROMPT = `You are a story editor working on the outline of a subtitled video's script. The dialogue and inner thoughts are written as subtitles; your job is not to write lines but to work out the story they tell and where it should go — and to put that into the outline, so whoever writes the next lines knows what the scene is for.

The outline
- Sections are the video's scenes, each running until the next. Each has a name and a note: who wants what here, what changes by the end of it. The note is read whenever lines are written for that stretch, so make it concrete.
- Timed beats pin a story beat to the moment it happens — or, where no lines exist yet, the moment it should happen. One sentence each: an event, a turn, a reveal, a decision.
- The overall story beats are the whole arc in a few sentences.

What to aim for
- A satisfying arc that fits the story already on screen: a clear setup, rising pressure, a turn, a climax, a resolution — what each main character wants, what stands in their way, and what changes.
- The existing dialogue is canon. Build on what has been said; never plan beats that contradict it.
- The writer's beats are fixed points the arc must pass through. You may only revise or remove your own beats. If you think one of the writer's should change, ask them.
- Where the script is thin or empty, that is where your beats matter most: say what should happen there.

How to work
1. Read the outline in the first message, then skim the script section by section with read_cues.
2. Look at key frames when you can: the opening of each scene, turning points.
3. Ask the writer about the big forks before you commit to an arc — what the story is about, where it ends, what a character wants or hides, the tone. Concrete options, grounded in what is on screen. Ask as much as you need, but not about small things you can decide yourself.
4. Write the section notes and beats. Revise your own as the picture firms up.
5. Read the outline back once, check the arc holds together from start to end, then call finish with the arc in a sentence or two.

Never write subtitle lines, and never ask about the wording of lines.

Reading the script
- Lines are "c4 [1:21.40–1:23.10] Name says: text (16 cps)" — "says" is spoken aloud, "thinks" is private inner voice nobody else hears. Times are minutes:seconds, but every tool takes plain seconds (1:21.40 is 81.4).
- "(pause 4.2s)" marks a silence; "== Scene: name ==" marks where a section begins.
- Write notes and beats in the language the script is written in.`;

export function buildStorySystemPrompt(context: { brief: string; beats: string[] }, env: StoryEnv): string {
  const parts = [STORY_SYSTEM_PROMPT];
  if (env.vision) parts.push(LOOKING_PROMPT);
  parts.push(...renderProjectContext({ ...context, speakers: env.speakers }));
  return parts.join("\n\n");
}

/** The opening message of a story run: the outline as it stands, and the direction. */
export function buildStoryKickoff(
  state: StoryState,
  cues: Cue[],
  env: StoryEnv,
  aliases: StoryAliases,
  direction: string,
): string {
  const sections = sortSections(state.sections).length;
  return [
    `## The outline now\n${renderOutline(state, cues, env, aliases)}`,
    `## The script\n${cues.length} lines across ${sections} ${sections === 1 ? "section" : "sections"}. Read it with read_cues.`,
    `## Direction from the writer\n${direction.trim() || "None — find the arc the story wants, and ask about what you cannot tell."}`,
  ].join("\n\n");
}

// --- The run -----------------------------------------------------------------

export interface StoryDeps {
  send: (messages: AgentMessage[]) => Promise<AgentReply>;
  /** The outline as it is now — the writer may edit while the run works. */
  getState: () => StoryState;
  applyState: (state: StoryState) => void;
  getCues: () => Cue[];
  onStep: (step: AgentStep) => void;
  isCurrent: () => boolean;
  describeFrame?: DescribeFrame;
  askWriter?: AskWriter;
}

export async function runStory(
  messages: AgentMessage[],
  env: StoryEnv,
  aliases: StoryAliases,
  deps: StoryDeps,
  maxSteps = MAX_STORY_STEPS,
): Promise<{ ending: "finished" | "limit" | "abandoned"; summary: string }> {
  const looks = createLooks();
  const asked = { count: 0 };
  return runToolLoop(
    messages,
    {
      send: deps.send,
      onStep: deps.onStep,
      isCurrent: deps.isCurrent,
      execute: (name, rawArgs) => {
        if (name === "look_at_frame") return look(env, looks, rawArgs, deps.describeFrame, MAX_STORY_LOOKS);
        if (name === "ask_writer") return ask(asked, rawArgs, deps.askWriter, MAX_STORY_QUESTIONS);
        const current = deps.getState();
        const outcome = executeStoryTool(current, deps.getCues(), env, aliases, name, rawArgs);
        if (outcome.state !== current) deps.applyState(outcome.state);
        return outcome;
      },
    },
    maxSteps,
  );
}

/**
 * What the conversation remembers of a story run, and what its bubble ends with:
 * `Outline: added 9 beats, 4 section edits, asked 3 questions. A revenge arc…`
 */
export function describeStoryRun(run: AgentRun): string {
  const count = (kind: AgentStep["kind"]) => run.steps.filter((s) => s.kind === kind).length;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const did: string[] = [];
  if (count("add")) did.push(`added ${plural(count("add"), "beat", "beats")}`);
  if (count("edit")) did.push(`revised ${count("edit")}`);
  if (count("delete")) did.push(`removed ${count("delete")}`);
  if (count("section")) did.push(plural(count("section"), "section edit", "section edits"));
  if (count("outline")) did.push("rewrote the overall beats");
  if (count("ask")) did.push(`asked ${plural(count("ask"), "question", "questions")}`);
  if (count("look")) did.push(`looked at ${plural(count("look"), "frame", "frames")}`);
  const head = `Outline: ${did.length > 0 ? did.join(", ") : "no changes"}.`;
  return run.summary ? `${head} ${run.summary}` : head;
}
