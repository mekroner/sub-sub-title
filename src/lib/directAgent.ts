/**
 * `/direct`: the chat model directs the voiceover. It reads the script scene by
 * scene — what each scene is for, who is reacting to what, who only thinks it —
 * and gives every line a note on how it is said and, where it helps, a voice
 * script with Chatterbox Turbo's tags placed in it. It never touches the
 * subtitles: everything it writes lands in the cues' voicing, where the Voice
 * line tab shows it and the writer can change it.
 *
 * Each line it directs comes back as what the engine will actually be asked to
 * say, so a note the keyword mapping in `direction.ts` does not understand is
 * visible to the model, which can reword it. Like the other runs, the tools
 * refuse rather than quietly adjust.
 */

import type { AgentMessage, AgentReply, AgentRun, AgentStep, Cue, CueVoicing, Section, Speaker, TimedBeat, Voiceover } from "../types";
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
  str,
  timeParam,
  type Aliases,
  type AskWriter,
  type CallOutcome,
  type DescribeFrame,
  runToolLoop,
} from "./agent";
import { sortCues } from "./cues";
import { TURBO_TAGS, stripTags } from "./direction";
import { renderProjectContext } from "./fill";
import { sectionAt, sectionSpans } from "./sections";
import { beatsBetween, renderTimedBeats } from "./timedBeats";
import { charsPerSecond, formatShort } from "./time";
import { castKey, lineGroups, renderLine, setVoicing, voiceFor, voicingFor } from "./tts";

/** Model turns a direction run may take: about a read and a write per scene. */
export const MAX_DIRECT_STEPS = 120;
export const MAX_DIRECT_QUESTIONS = 3;
export const MAX_DIRECT_LOOKS = 12;
/** Most lines one `direct_lines` call may direct. */
export const DIRECT_BATCH = 30;
/** Most script lines one `read_cues` returns. */
const READ_LIMIT = 120;
const DIRECTION_CHARS = 120;
/** Words a voice script may add to its line: a hesitation, a repeat. */
const MAX_ADDED_WORDS = 4;
/** Undirected lines a refused `finish` names. */
const MISSING_SHOWN = 10;
const PAUSE_THRESHOLD = 2.5;

/** Ad-read delivery has no place in a film's voiceover. */
const DIRECTABLE_TAGS = TURBO_TAGS.filter((tag) => tag !== "[advertisement]");

// --- The command ------------------------------------------------------------

/** `/direct`, `/direct understated, naturalistic` — or null for any other message. */
export function parseDirectCommand(text: string): { direction: string } | null {
  const match = /^\/direct(?:\s+|$)(.*)$/is.exec(text.trim());
  return match ? { direction: match[1].trim() } : null;
}

// --- The run's world --------------------------------------------------------

export interface DirectEnv {
  /** Seconds; 0 when unknown. */
  duration: number;
  vision: boolean;
  speakers: Speaker[];
  sections: Section[];
  timedBeats: TimedBeat[];
}

const span = (start: number, end: number) => `${formatShort(start)}–${formatShort(end)}`;

const clip = (text: string, max: number) => {
  const line = oneLine(text);
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

function speakerName(speakers: Speaker[], id: string | null): string {
  return speakers.find((s) => s.id === id)?.name.trim() || "Someone";
}

const engineName = (voiceover: Voiceover, cue: Cue) =>
  voiceFor(voiceover, castKey(cue)).engine === "standard" ? "expressive" : "turbo";

/** A line the run must direct: one with words in its subtitle. */
const needsDirection = (cue: Cue) => oneLine(cue.text) !== "";

/** For each cue spoken together with others, the aliases of its whole line: `c4+c5`. */
function joinedLabels(voiceover: Voiceover, cues: Cue[], aliases: Aliases): Map<string, string> {
  const joined = new Map<string, string>();
  for (const group of lineGroups(voiceover, cues)) {
    if (group.length < 2) continue;
    const label = group.map((c) => aliasFor(aliases, c.id)).join("+");
    for (const cue of group) joined.set(cue.id, label);
  }
  return joined;
}

/**
 * One cue as the model reads it, with its voice and how it is directed now:
 * `c4 [1:21.40–1:23.10] Anna says: I know. (16 cps, turbo) — direction: guilty · script: [sigh] I know.`
 */
function renderVoiceCue(cue: Cue, voiceover: Voiceover, env: DirectEnv, aliases: Aliases, joined?: string): string {
  const verb = cue.mode === "thought" ? "thinks" : "says";
  const cps = Math.round(charsPerSecond(cue.text, cue.start, cue.end));
  const notes = [`${cps} cps`, engineName(voiceover, cue)];
  if (joined) notes.push(`spoken as one line: ${joined}`);
  const who = speakerName(env.speakers, cue.speakerId);
  const head = `${aliasFor(aliases, cue.id)} [${span(cue.start, cue.end)}] ${who} ${verb}: ${oneLine(cue.text) || "…"} (${notes.join(", ")})`;
  const voicing = voicingFor(voiceover, cue.id);
  const now: string[] = [];
  if (voicing.direction) now.push(`direction: ${oneLine(voicing.direction)}`);
  if (voicing.spoken) now.push(`script: ${oneLine(voicing.spoken)}`);
  return now.length > 0 ? `${head} — ${now.join(" · ")}` : head;
}

/** Cues in time order with their voicing, silences and scene changes called out. */
export function renderVoiceLines(cues: Cue[], voiceover: Voiceover, env: DirectEnv, aliases: Aliases): string {
  const joined = joinedLabels(voiceover, cues, aliases);
  const out: string[] = [];
  let scene: Section | null = null;
  let previousEnd: number | null = null;
  for (const cue of sortCues(cues)) {
    if (previousEnd !== null && cue.start - previousEnd >= PAUSE_THRESHOLD) {
      out.push(`(pause ${(cue.start - previousEnd).toFixed(1)}s)`);
    }
    const here = sectionAt(env.sections, cue.start);
    if (here && here.id !== scene?.id) out.push(`== Scene: ${oneLine(here.label) || "untitled"} ==`);
    scene = here;
    out.push(renderVoiceCue(cue, voiceover, env, aliases, joined.get(cue.id)));
    previousEnd = cue.end;
  }
  return out.join("\n");
}

/**
 * The scenes as the run first sees them: each with its span, note, planned
 * beats, and how many of its lines are directed so far.
 */
export function renderScenes(cues: Cue[], voiceover: Voiceover, env: DirectEnv): string {
  const end = env.duration > 0 ? env.duration : Math.max(0, ...cues.map((c) => c.end));
  const spans = sectionSpans(env.sections, end);
  const stretches: Array<{ label: string; start: number; end: number; note: string }> = [];
  const first = spans[0]?.start ?? end;
  if (first > 0 && cues.some((c) => c.start < first)) {
    stretches.push({ label: "Before any section", start: 0, end: first, note: "" });
  }
  for (const s of spans) stretches.push({ label: `"${oneLine(s.label) || "untitled"}"`, start: s.start, end: s.end, note: oneLine(s.note ?? "") });

  const out: string[] = [];
  for (const stretch of stretches) {
    const lines = cues.filter((c) => needsDirection(c) && c.start >= stretch.start && c.start < stretch.end);
    const directed = lines.filter((c) => voicingFor(voiceover, c.id).direction).length;
    out.push(`[${span(stretch.start, stretch.end)}] ${stretch.label} — ${lines.length} lines, ${directed} directed`);
    if (stretch.note) out.push(`   Note: ${stretch.note}`);
    const beats = renderTimedBeats(beatsBetween(env.timedBeats, stretch.start, stretch.end));
    if (beats) out.push(beats.split("\n").map((b) => `   ${b}`).join("\n"));
  }
  return out.length > 0 ? out.join("\n") : "(no script yet)";
}

// --- Checking a voice script ------------------------------------------------------

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/** Whether `line`'s words all appear in `script`, in order. */
function keepsWords(line: string[], script: string[]): boolean {
  let at = 0;
  for (const word of script) if (at < line.length && word === line[at]) at++;
  return at === line.length;
}

const sameTag = (a: string, b: string) => a.replace(/\s+/g, " ").toLowerCase() === b.toLowerCase();

/** Refuses a voice script the cue's engine could not perform, or that rewords the line. */
function checkScript(cue: Cue, engine: "turbo" | "expressive", spoken: string) {
  const brackets = spoken.match(/\[[^\]]*\]/g) ?? [];
  if (engine === "expressive" && brackets.length > 0) {
    refuse("this voice is Expressive, which reads tags aloud. Shape it with punctuation only.");
  }
  const unknown = brackets.filter((b) => !DIRECTABLE_TAGS.some((tag) => sameTag(b, tag)));
  if (unknown.length > 0) refuse(`${unknown.join(" ")} is not a tag Turbo knows; it would be read aloud.`);
  const line = words(cue.text);
  const script = words(stripTags(spoken));
  if (!keepsWords(line, script)) refuse("the script must keep the line's words, in order. Leave numbers as written.");
  if (script.length - line.length > MAX_ADDED_WORDS) {
    refuse(`the script adds ${script.length - line.length} words; add at most ${MAX_ADDED_WORDS} (a hesitation, a repeat).`);
  }
}

/** What the engine will do with a directed line, in a few words. */
function performed(voiceover: Voiceover, cue: Cue): string {
  const line = renderLine(voiceover, cue);
  if (line.voice.engine !== "standard") return `speaks: ${line.text}`;
  const own = line.exaggeration === line.voice.exaggeration;
  return `speaks: ${line.text} (intensity ${line.exaggeration}${own ? ", the voice's own" : ""})`;
}

// --- Tools -------------------------------------------------------------------

export const DIRECT_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_cues",
      description: `Read the script between two times, with each line's voice and current direction. Read scene by scene; at most ${READ_LIMIT} lines come back at once.`,
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
      name: "direct_lines",
      description: `Direct up to ${DIRECT_BATCH} lines: a short note on how each is said and, where it helps, a voice script. Each line's note and script are replaced together. The result shows what the voice engine will be asked to say.`,
      parameters: {
        type: "object",
        properties: {
          lines: {
            type: "array",
            maxItems: DIRECT_BATCH,
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "The line's id, e.g. c4." },
                direction: { type: "string", description: "How it is said, in a few English words, e.g. \"guilty, barely audible\"." },
                spoken: {
                  type: "string",
                  description:
                    "Optional: the line as performed — its own words, with Turbo tags placed where they happen, or punctuation for an Expressive voice. Leave it out to speak the line as written.",
                },
              },
              required: ["id", "direction"],
            },
          },
        },
        required: ["lines"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "Call once every line is directed. Ends your turn.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string", description: "One or two sentences for the writer: the approach you took." } },
        required: ["summary"],
      },
    },
  },
  askTool(
    `Ask the writer a multiple-choice question about the performance: the overall register, how a character sounds, how big a key moment should play. Only about forks that change many lines — decide single lines yourself. You have ${MAX_DIRECT_QUESTIONS} per run.`,
  ),
];

const DIRECT_LOOK_TOOL = lookTool(
  `See what is on screen at a moment: a separate vision model describes that frame in words. Look where the picture changes how a line plays — who is close, who is shouting across a room, whether a scene is tender or tense. Each look is slow and costs money; you have ${MAX_DIRECT_LOOKS} per run.`,
);

/** The tools a direction run gets: looking at the video only when a vision model is set. */
export function directTools(vision: boolean): unknown[] {
  return vision ? [...DIRECT_TOOLS, DIRECT_LOOK_TOOL] : DIRECT_TOOLS;
}

export interface DirectOutcome extends CallOutcome {
  /** The same object when nothing changed. */
  voiceover: Voiceover;
}

function fail(voiceover: Voiceover, name: string, message: string): DirectOutcome {
  return { voiceover, result: `Error: ${message}`, step: { kind: "error", label: `${name}: ${message}` } };
}

/**
 * Runs one direction tool against `voiceover`. Never throws: a bad call comes
 * back as an error the model reads and can correct.
 */
export function executeDirectTool(
  voiceover: Voiceover,
  cues: Cue[],
  env: DirectEnv,
  aliases: Aliases,
  name: string,
  rawArgs: string,
): DirectOutcome {
  const args = parseArgs(rawArgs);
  if (!args) return fail(voiceover, name, BAD_ARGS);
  try {
    return runDirectTool(voiceover, cues, env, aliases, name, args);
  } catch (e) {
    if (e instanceof Refusal) return fail(voiceover, name, e.message);
    throw e;
  }
}

function runDirectTool(
  voiceover: Voiceover,
  cues: Cue[],
  env: DirectEnv,
  aliases: Aliases,
  name: string,
  args: Record<string, unknown>,
): DirectOutcome {
  switch (name) {
    case "read_cues": {
      const from = num(args, "from")!;
      const to = num(args, "to")!;
      if (to <= from) refuse("`to` must be after `from`.");
      const found = cuesBetween(cues, from, to);
      const shown = found.slice(0, READ_LIMIT);
      const more = found.length - shown.length;
      const body = shown.length > 0 ? renderVoiceLines(shown, voiceover, env, aliases) : "(no lines)";
      return {
        voiceover,
        result: more > 0 ? `${body}\n(${more} more lines; read a shorter stretch)` : body,
        step: { kind: "read", label: `Read ${span(from, to)}` },
      };
    }

    case "direct_lines": {
      const raw = Array.isArray(args.lines) ? args.lines : [];
      if (raw.length === 0) refuse("Give `lines`: an array of { id, direction, spoken? }.");
      if (raw.length > DIRECT_BATCH) refuse(`Direct at most ${DIRECT_BATCH} lines per call.`);
      let next = voiceover;
      const done: Cue[] = [];
      const results: string[] = [];
      const refused: string[] = [];
      for (const item of raw) {
        const line = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
        const ref = typeof line.id === "string" ? line.id.trim() : String(line.id);
        try {
          const id = aliases.byAlias.get(ref);
          const cue = id ? cues.find((c) => c.id === id) : undefined;
          if (!cue) refuse(`there is no line "${ref}". Use an id from read_cues.`);
          if (!needsDirection(cue)) refuse("this line has no words to direct.");
          const direction = clip(typeof line.direction === "string" ? line.direction : "", DIRECTION_CHARS);
          if (!direction) refuse("`direction` is empty.");
          const spoken = typeof line.spoken === "string" ? oneLine(line.spoken) : "";
          if (spoken) checkScript(cue, engineName(next, cue), spoken);
          // Note and script together, so an old script's tags never outlive a new note.
          next = setVoicing(next, cue.id, cue.text, { direction, spoken: spoken || undefined });
          done.push(cue);
          results.push(`${ref} → ${performed(next, cue)}`);
        } catch (e) {
          if (!(e instanceof Refusal)) throw e;
          refused.push(`${ref}: ${e.message}`);
        }
      }
      const body = [
        ...results,
        ...(refused.length > 0 ? ["", `Not directed (fix and send again):`, ...refused] : []),
      ].join("\n");
      if (done.length === 0) {
        return { voiceover, result: `Error: no line was directed.\n${refused.join("\n")}`, step: { kind: "error", label: `direct_lines: ${refused[0]}` } };
      }
      const scene = sectionAt(env.sections, done[0].start);
      const where = scene ? ` · “${oneLine(scene.label) || "untitled"}”` : "";
      const detail = done
        .map((cue) => `${aliasFor(aliases, cue.id)} ${voicingFor(next, cue.id).direction} → ${renderLine(next, cue).text}`)
        .join("\n");
      return {
        voiceover: next,
        result: body,
        step: {
          kind: "direct",
          label: `🎙 Directed ${done.length} ${done.length === 1 ? "line" : "lines"}${where}${refused.length > 0 ? ` (${refused.length} refused)` : ""}`,
          detail,
          count: done.length,
        },
      };
    }

    case "finish": {
      const missing = sortCues(cues).filter((c) => needsDirection(c) && !voicingFor(voiceover, c.id).direction);
      if (missing.length > 0) {
        const shown = missing
          .slice(0, MISSING_SHOWN)
          .map((c) => `${aliasFor(aliases, c.id)} [${span(c.start, c.end)}]`)
          .join(", ");
        const more = missing.length > MISSING_SHOWN ? `, and ${missing.length - MISSING_SHOWN} more` : "";
        refuse(`${missing.length} lines have no direction yet: ${shown}${more}. Direct every line, a plain one with a plain note.`);
      }
      return { voiceover, result: "Finished.", step: null, finished: oneLine(str(args, "summary") ?? "") };
    }

    default:
      return refuse(`There is no tool "${name}".`);
  }
}

// --- Prompt ------------------------------------------------------------------

const DIRECT_SYSTEM_PROMPT = `You are the voice director for a film's voiceover. The dialogue and inner thoughts are subtitles, and each line is spoken by a text-to-speech voice. Your job is to give every line a direction — a short note on how it is said — and, where it helps, a voice script that performs it. You never change the subtitles.

What a good direction draws on
- What the scene is for: its note and planned beats say who wants what and where it turns.
- What the speaker is reacting to: the line before, what has just happened, what they know and hide. Play the subtext, not just the words.
- The character: how they talk, from the characters list. Keep a character consistent within a scene, and let it shift only when the story does.
- "thinks" lines are inner voice: close, quiet and private, never projected.
- Timing: a line with many characters per second, or a tight gap before the next, wants a quick delivery.
- Build across a scene. Most lines are conversational; save the big readings for the moments that earn them.

How the voice engines read you
- Each line shows its voice: turbo or expressive.
- Turbo performs tags. A note with one of these words adds its tag at the start of the line: whisper → [whispering]; cry, tearful, sob → [crying]; angry, furious, shout, yell → [angry]; afraid, scared, terrified → [fear]; happy, cheerful, warm, bright → [happy]; surprised, shocked, startled → [surprised]; dry, deadpan, sarcastic, mocking → [sarcastic]; dramatic, theatrical → [dramatic]; laugh, chuckle, sigh, gasp, groan, cough, sniff → that sound.
- For a sound in the middle of a line, or a delivery that changes partway, write a voice script with the tag where it happens: "I told you. [sigh] I told you twice." The tags are ${DIRECTABLE_TAGS.join(" ")}. Nothing else in square brackets. Most lines want one tag or none; a sound only where it is motivated.
- Expressive reads tags aloud, so its scripts use punctuation only: commas and ellipses for hesitation, dashes for breaks. Its notes set an intensity: scream, furious, frantic push it far up; shout, angry, excited, intense, dramatic, passionate, terrified push it up; whisper, quiet, soft, calm, flat, tired, gentle, murmur bring it down. Other words keep the voice's own.
- Lines "spoken as one line" with others share one take; on Expressive they share the strongest intensity among them.
- Every directed line comes back as what the engine will be asked to say. If a note changed nothing you meant it to, reword it.

Voice scripts
- Keep the line's words, in order, in the script's language. You may add a hesitation or a repeated word, and shape the punctuation; never reword, translate or censor.
- Leave numbers and symbols as written: they are spelled out for you.
- Leave the script out when the note alone does the job.

Existing directions are the writer's earlier intent: keep what fits, rewrite what does not.

How to work
1. Read the scenes in the first message.
2. Scene by scene: read_cues for the scene, then direct_lines for all its lines, in batches of up to ${DIRECT_BATCH}.
3. Look at a frame when the picture would change how a scene plays, if you can.
4. Ask the writer only about forks that change many lines — the overall register, how a main character sounds. Decide the rest.
5. Call finish once every line is directed, with a sentence on your approach.

Reading the script
- Lines are "c4 [1:21.40–1:23.10] Name says: text (16 cps, turbo) — direction: … · script: …". Times are minutes:seconds, but every tool takes plain seconds (1:21.40 is 81.4).
- "(pause 4.2s)" marks a silence; "== Scene: name ==" marks where a section begins.
- Write directions in English, whatever the script's language.`;

export function buildDirectSystemPrompt(context: { brief: string; beats: string[] }, env: DirectEnv): string {
  const parts = [DIRECT_SYSTEM_PROMPT];
  if (env.vision) parts.push(LOOKING_PROMPT);
  parts.push(...renderProjectContext({ ...context, speakers: env.speakers }));
  return parts.join("\n\n");
}

/** The opening message of a direction run: the scenes, and the writer's note. */
export function buildDirectKickoff(cues: Cue[], voiceover: Voiceover, env: DirectEnv, direction: string): string {
  const lines = cues.filter(needsDirection).length;
  return [
    `## The scenes\n${renderScenes(cues, voiceover, env)}`,
    `## The script\n${lines} lines to direct${env.duration > 0 ? ` across ${formatShort(env.duration)}` : ""}. Read it with read_cues.`,
    `## Direction from the writer\n${direction.trim() || "None — find the performance the story wants, and ask about what you cannot tell."}`,
  ].join("\n\n");
}

// --- The run -----------------------------------------------------------------

export interface DirectDeps {
  send: (messages: AgentMessage[]) => Promise<AgentReply>;
  /** The voiceover as it is now — the writer may edit while the run works. */
  getVoiceover: () => Voiceover;
  /** The run's edits: only ever the cues' voicing. */
  applyVoicing: (voicing: Record<string, CueVoicing>) => void;
  getCues: () => Cue[];
  onStep: (step: AgentStep) => void;
  isCurrent: () => boolean;
  describeFrame?: DescribeFrame;
  askWriter?: AskWriter;
}

export async function runDirect(
  messages: AgentMessage[],
  env: DirectEnv,
  aliases: Aliases,
  deps: DirectDeps,
  maxSteps = MAX_DIRECT_STEPS,
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
        if (name === "look_at_frame") return look(env, looks, rawArgs, deps.describeFrame, MAX_DIRECT_LOOKS);
        if (name === "ask_writer") return ask(asked, rawArgs, deps.askWriter, MAX_DIRECT_QUESTIONS);
        const current = deps.getVoiceover();
        const outcome = executeDirectTool(current, deps.getCues(), env, aliases, name, rawArgs);
        if (outcome.voiceover !== current) deps.applyVoicing(outcome.voiceover.voicing);
        return outcome;
      },
    },
    maxSteps,
  );
}

/**
 * What the conversation remembers of a direction run, and what its bubble ends
 * with: `Direction: directed 84 lines, asked 1 question. Understated…`
 */
export function describeDirectRun(run: AgentRun): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const lines = run.steps.filter((s) => s.kind === "direct").reduce((n, s) => n + (s.count ?? 0), 0);
  const asked = run.steps.filter((s) => s.kind === "ask").length;
  const looked = run.steps.filter((s) => s.kind === "look").length;
  const did: string[] = [];
  if (lines) did.push(`directed ${plural(lines, "line", "lines")}`);
  if (asked) did.push(`asked ${plural(asked, "question", "questions")}`);
  if (looked) did.push(`looked at ${plural(looked, "frame", "frames")}`);
  const head = `Direction: ${did.length > 0 ? did.join(", ") : "no changes"}.`;
  return run.summary ? `${head} ${run.summary}` : head;
}
