/**
 * The chat panel: a place to think out loud about the project with a model
 * that already knows it. Nothing it says goes back into the script.
 *
 * The model always gets the standing picture — brief, beats, cast, the scene
 * the writer is in — rebuilt on every send so edits show up at once. Script
 * excerpts are attached by hand, and captured when attached, so a question
 * about "these lines" still means those lines after the script moves on.
 *
 * Free of React so the prompt can be pinned by tests. The transcript format is
 * Fill's, so every AI feature reads the script the same way.
 */

import type {
  ChatAttachment,
  ChatEffort,
  ChatMessage,
  ChatRequest,
  Cue,
  Section,
  Speaker,
  TimedBeat,
} from "../types";
import { buildTranscript, renderProjectContext, renderTranscript } from "./fill";
import { sectionAt, sectionSpans } from "./sections";
import { beatsBetween, renderTimedBeats } from "./timedBeats";
import { formatShort } from "./time";

export const MIN_CHAT_LINES = 1;
export const MAX_CHAT_LINES = 100;

/** Room for a considered answer with a list in it; the backend clamps too. */
export const CHAT_MAX_TOKENS = 1500;

/**
 * With an effort set, the model's thinking comes out of the same budget, so
 * leave room for it and an answer after.
 */
export const CHAT_MAX_TOKENS_REASONING = 12000;

/** The effort select's choices. "" leaves reasoning to the model. */
export const CHAT_EFFORTS: ReadonlyArray<{ value: ChatEffort | ""; label: string }> = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

/** A stored effort, or null for one that is unset or no longer known. */
export function chatEffort(value: string): ChatEffort | null {
  return CHAT_EFFORTS.some((e) => e.value !== "" && e.value === value)
    ? (value as ChatEffort)
    : null;
}

/** The model to chat with: the pick while it is still listed, else the first. */
export function resolveChatModel(models: string[], picked: string): string {
  return models.includes(picked) ? picked : (models[0] ?? "");
}

/** "anthropic/claude-sonnet-4.5" → "claude-sonnet-4.5", for a narrow select. */
export function shortModelName(id: string): string {
  return id.slice(id.indexOf("/") + 1) || id;
}

/** What a message holding only an attachment asks. */
export const ATTACHMENT_ONLY_PROMPT = "Here's the latest stretch. Thoughts?";

export const CHAT_SYSTEM_PROMPT = `You are a writing partner for someone writing the dialogue and inner thoughts of a subtitled video. They come to you to develop ideas: what could happen next, why a scene isn't working, what a character really wants, how a line could land harder. Nothing you write here is inserted into the script — this is a conversation, so be direct and conversational. The one exception is when the writer sends "/continue": you then write lines straight into the script, and the conversation keeps a one-line summary of what you did.

How to help
- Engage with the actual material. Quote or point to specific lines when it helps.
- When asked for ideas, give a few genuinely different options, not variations on one.
- Say plainly when something isn't working, and why. Ask a sharp question when the writer's intent is unclear.
- Keep answers tight. Short paragraphs or brief lists; no preamble, no recap of the question.
- Write in the language the writer uses with you. Sample dialogue should match the language and voice of the script.

Reading the material
- Transcript lines are "[time] Name says: text" (spoken aloud) or "[time] Name thinks: text" (private inner voice nobody else hears).
- "(pause 4.2s)" marks a silence; "== Scene: name ==" marks where a section of the video begins.
- "## Selected lines" are the lines the writer had selected when sending — usually what "this line" or "these lines" means. A lone "…" there marks lines left out between them.
- The project brief, story beats, characters and current scene below are background. Script excerpts arrive with the writer's messages.`;

/**
 * Where "the last N lines" end, in seconds: the primary selected cue's start,
 * or the playhead when nothing is selected.
 */
export function anchorFor(cues: Cue[], primaryId: string | null, currentTime: number): number {
  const selected = primaryId ? cues.find((c) => c.id === primaryId) : undefined;
  return selected ? selected.start : currentTime;
}

/**
 * The last `n` cues starting at or before `anchor`, rendered for the model — or
 * null when there are none.
 */
export function buildAttachment(
  cues: Cue[],
  sections: Section[],
  speakers: Speaker[],
  anchor: number,
  n: number,
): ChatAttachment | null {
  const count = Math.max(MIN_CHAT_LINES, Math.min(MAX_CHAT_LINES, Math.round(n)));
  const upTo = [...cues].sort((a, b) => a.start - b.start).filter((c) => c.start <= anchor);
  const lines = upTo.slice(-count);
  if (lines.length === 0) return null;

  // No slots and no window: every cue passed in counts as "before", so the
  // transcript is exactly these lines with pauses and scene changes marked.
  const items = buildTranscript(lines, [], sections, lines.length, 0, null);
  return {
    cueCount: lines.length,
    from: lines[0].start,
    to: Math.max(...lines.map((c) => c.end)),
    transcript: renderTranscript(items, speakers),
  };
}

/**
 * Every selected cue, rendered for the model — or null when nothing is
 * selected. Picks that are not neighbours in the script are joined by "…", so
 * the lines skipped between them do not read as a silence.
 */
export function buildSelection(
  cues: Cue[],
  sections: Section[],
  speakers: Speaker[],
  selectedIds: ReadonlySet<string>,
): ChatAttachment | null {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const runs: Cue[][] = [];
  let previous = -2;
  sorted.forEach((cue, index) => {
    if (!selectedIds.has(cue.id)) return;
    if (index === previous + 1) runs[runs.length - 1].push(cue);
    else runs.push([cue]);
    previous = index;
  });
  if (runs.length === 0) return null;

  const lines = runs.flat();
  return {
    cueCount: lines.length,
    from: lines[0].start,
    to: Math.max(...lines.map((c) => c.end)),
    transcript: runs
      .map((run) => renderTranscript(buildTranscript(run, [], sections, run.length, 0, null), speakers))
      .join("\n…\n"),
  };
}

export function attachmentLabel(attachment: ChatAttachment): string {
  const noun = attachment.cueCount === 1 ? "line" : "lines";
  return `${attachment.cueCount} ${noun} · ${formatShort(attachment.from)}–${formatShort(attachment.to)}`;
}

export interface ChatContext {
  brief: string;
  beats: string[];
  speakers: Speaker[];
  sections: Section[];
  /** Seconds; picks the current scene. */
  anchor: number;
  /** The scene's planned beats are shown with it. */
  timedBeats?: TimedBeat[];
}

export function buildChatSystemPrompt(context: ChatContext): string {
  const parts = [CHAT_SYSTEM_PROMPT, ...renderProjectContext(context)];
  const scene = renderCurrentScene(context.sections, context.anchor, context.timedBeats);
  if (scene) parts.push(scene);
  return parts.join("\n\n");
}

/** The scene `anchor` falls in, with its note and planned beats, as a prompt section. */
export function renderCurrentScene(
  sections: Section[],
  anchor: number,
  timedBeats: TimedBeat[] = [],
): string | null {
  const scene = sectionAt(sections, anchor);
  if (!scene) return null;
  const lines = [`## Current scene\n${scene.label.trim() || "Untitled"} (from ${formatShort(scene.start)})`];
  const note = scene.note?.trim();
  if (note) lines.push(`Note: ${note}`);
  const end = sectionSpans(sections, Infinity).find((s) => s.id === scene.id)?.end ?? Infinity;
  const beats = renderTimedBeats(beatsBetween(timedBeats, scene.start, end));
  if (beats) lines.push(`Planned beats:\n${beats}`);
  return lines.join("\n");
}

/** What the model reads for one of the writer's messages. */
export function userContent(
  message: Pick<ChatMessage, "text" | "attachment" | "selection">,
): string {
  const text = message.text.trim() || (message.attachment ? ATTACHMENT_ONLY_PROMPT : "");
  if (!text) return "";
  const parts: string[] = [];
  if (message.attachment) parts.push(excerpt("Script excerpt", message.attachment));
  if (message.selection) parts.push(excerpt("Selected lines", message.selection));
  parts.push(text);
  return parts.join("\n\n");
}

function excerpt(heading: string, { from, to, transcript }: ChatAttachment): string {
  return `## ${heading} (${formatShort(from)}–${formatShort(to)})\n${transcript}`;
}

/**
 * The conversation after the writer rewrites one of their messages: everything
 * before it, then the rewritten message under a fresh id. Whatever followed —
 * the reply to it and every later turn — is dropped, since it answered words
 * that no longer exist. Null when there is no such message, or the edit would
 * leave it asking nothing. The selection stays as it was first sent.
 */
export function rewriteMessage(
  history: ChatMessage[],
  id: string,
  edit: { text: string; attachment: ChatAttachment | null },
  newId: string,
): { earlier: ChatMessage[]; question: ChatMessage } | null {
  const index = history.findIndex((m) => m.id === id && m.role === "user");
  if (index < 0) return null;
  const text = edit.text.trim();
  if (!text && !edit.attachment) return null;
  const { selection } = history[index];
  return {
    earlier: history.slice(0, index),
    question: {
      id: newId,
      role: "user",
      text,
      ...(edit.attachment ? { attachment: edit.attachment } : {}),
      ...(selection ? { selection } : {}),
    },
  };
}

/**
 * The conversation as sent. Failed replies are left out, and so are stopped
 * ones that never got a word out; a reply stopped part-way is kept, since the
 * writer may be following up on what it did say.
 */
export function historyTurns(
  history: ChatMessage[],
): Array<{ role: "user" | "assistant"; content: string }> {
  const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const message of history) {
    if (message.role === "user") {
      turns.push({ role: "user", content: userContent(message) });
    } else if (message.status !== "error" && message.status !== "streaming" && message.text.trim()) {
      turns.push({ role: "assistant", content: message.text });
    }
  }
  return turns;
}

export function buildChatRequest(
  system: string,
  history: ChatMessage[],
  settings: { model: string; temperature: number; effort?: ChatEffort | null },
): ChatRequest {
  const messages: ChatRequest["messages"] = [{ role: "system", content: system }, ...historyTurns(history)];
  const effort = settings.effort ?? null;
  return {
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: effort ? CHAT_MAX_TOKENS_REASONING : CHAT_MAX_TOKENS,
    messages,
    ...(effort ? { reasoningEffort: effort } : {}),
  };
}
