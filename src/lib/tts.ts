/**
 * Generated speech: who is voiced how, which cues are spoken as one line,
 * which clip holds each line, and when a clip no longer says what its cues
 * do. Pure functions over `Voiceover`, like the rest of the mix.
 */

import type { CastVoice, ClipTake, Cue, CueVoicing, VoiceClip, Voiceover } from "../types";
import { directionIntensity, directionTags, hasTag, stripTags } from "./direction";
import { resizeCue, sortCues } from "./cues";
import { makeId } from "./ids";
import { addTrack, clipEnd, voiceTracks } from "./voiceover";

/** Cast key for cues with no speaker. */
export const NO_SPEAKER = "";
/** A line running this far past its last cue is worth a warning. */
export const OVERRUN_TOLERANCE = 0.05;
/** How much of a speaker's own audio makes a good cloning reference. */
export const REFERENCE_TARGET_SECONDS = 15;
export const REFERENCE_MAX_SECONDS = 25;

/**
 * Automatic grouping is deliberately conservative: only a sentence that a
 * subtitle split across neighbouring cues, with no real pause between them,
 * is spoken as one line. Anything else can still be joined by hand.
 */
export const GROUP_MAX_GAP = 0.5;
/** Chatterbox rushes and drops words on long inputs; groups stay under these. */
export const GROUP_MAX_SPAN = 20;
export const GROUP_MAX_CHARS = 300;

export const DEFAULT_VOICE: CastVoice = {
  engine: "turbo",
  exaggeration: 0.5,
  cfgWeight: 0.5,
  temperature: 0.8,
};

export function castKey(cue: Pick<Cue, "speakerId">): string {
  return cue.speakerId ?? NO_SPEAKER;
}

export function voiceFor(voiceover: Voiceover, key: string): CastVoice {
  return voiceover.cast[key] ?? DEFAULT_VOICE;
}

export function setVoice(
  voiceover: Voiceover,
  key: string,
  patch: Partial<CastVoice>,
): Voiceover {
  const current = voiceFor(voiceover, key);
  const next: CastVoice = { ...current, ...patch };
  // `undefined` in a patch clears an optional field rather than storing it.
  if (next.reference === undefined) delete next.reference;
  if (next.trackId === undefined) delete next.trackId;
  if (next.referenceCueIds === undefined) delete next.referenceCueIds;
  return { ...voiceover, cast: { ...voiceover.cast, [key]: next } };
}

/**
 * Everything about a voice that changes what it says. A clip spoken with a
 * different key is stale; the track it lands on is not part of it.
 */
export function voiceKey(voice: CastVoice): string {
  const parts: Array<string | number> = [voice.engine, voice.reference ?? "", voice.temperature];
  if (voice.engine === "standard") parts.push(voice.exaggeration, voice.cfgWeight);
  return parts.join("|");
}

/** The text a cue is spoken from: its lines joined, whitespace collapsed. */
export function speechText(cue: Pick<Cue, "text">): string {
  return cue.text.replace(/\s+/g, " ").trim();
}

/** The clip holding the line a cue is part of, if one has been generated. */
export function clipForCue(voiceover: Voiceover, cueId: string): VoiceClip | undefined {
  return voiceover.clips.find((c) => c.source?.cueIds.includes(cueId));
}

export type LineState = "missing" | "stale" | "current";

export function voicingFor(voiceover: Voiceover, cueId: string): CueVoicing {
  return voiceover.voicing[cueId] ?? {};
}

/**
 * Updates a cue's voice script. Blank fields are dropped, and so is spoken
 * text identical to the cue's own (`cueText`), so an entry exists only while
 * it says something the cue does not.
 */
export function setVoicing(
  voiceover: Voiceover,
  cueId: string,
  cueText: string,
  patch: Partial<CueVoicing>,
): Voiceover {
  const next: CueVoicing = { ...voicingFor(voiceover, cueId), ...patch };
  // Exactly the cue, not merely equal once trimmed: otherwise the space typed
  // after "Fine." would make the script match, vanish, and take the space.
  if (!next.spoken?.trim() || next.spoken === cueText) delete next.spoken;
  if (!next.direction?.trim()) delete next.direction;
  const voicing = { ...voiceover.voicing };
  if (next.spoken === undefined && next.direction === undefined) delete voicing[cueId];
  else voicing[cueId] = next;
  return { ...voiceover, voicing };
}

export interface RenderedLine {
  /** Exactly what the engine is asked to say. */
  text: string;
  /** The Expressive model's intensity for this line. */
  exaggeration: number;
  voice: CastVoice;
}

/**
 * What one cue's part comes out as for its voice's model: its spoken text (or
 * its own), with the direction turned into tags for Turbo, or into an
 * intensity for Expressive — which reads tags aloud, so it gets none.
 */
export function renderLine(voiceover: Voiceover, cue: Cue): RenderedLine {
  const voice = voiceFor(voiceover, castKey(cue));
  const voicing = voicingFor(voiceover, cue.id);
  const base = speechText({ text: voicing.spoken ?? cue.text });
  const direction = voicing.direction ?? "";
  if (voice.engine === "standard") {
    return {
      text: stripTags(base),
      exaggeration: directionIntensity(direction) ?? voice.exaggeration,
      voice,
    };
  }
  const tags = directionTags(direction).filter((tag) => !hasTag(base, tag));
  return {
    text: [...tags, base].filter(Boolean).join(" "),
    exaggeration: voice.exaggeration,
    voice,
  };
}

/**
 * A whole line: each cue's part in order, so a tag written in the second cue
 * lands where that cue begins. One intensity serves the line, the strongest
 * any cue asks for.
 */
export function renderGroup(voiceover: Voiceover, group: Cue[]): RenderedLine {
  const parts = group.map((cue) => renderLine(voiceover, cue));
  return {
    text: parts.map((p) => p.text).filter(Boolean).join(" "),
    exaggeration: Math.max(...parts.map((p) => p.exaggeration)),
    voice: parts[0].voice,
  };
}

/** `voiceKey` with the line's own intensity, which direction can change. */
function renderedKey(line: RenderedLine): string {
  return voiceKey({ ...line.voice, exaggeration: line.exaggeration });
}

/**
 * Whether a cue has a line to speak. A cue with an empty subtitle can still
 * have spoken text — a lone [sigh], say.
 */
export function hasSomethingToSay(voiceover: Voiceover, cue: Cue): boolean {
  return renderLine(voiceover, cue).text !== "";
}

// --- Grouping -----------------------------------------------------------------

/** Ends with sentence punctuation, perhaps inside a closing quote or bracket. */
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;

function endsSentence(voiceover: Voiceover, cue: Cue): boolean {
  const spoken = stripTags(speechText({ text: voicingFor(voiceover, cue.id).spoken ?? cue.text }));
  return SENTENCE_END.test(spoken);
}

/**
 * Whether `next` is spoken together with the group ending in `prev`. A
 * speaker or mode change and the length caps always separate; an override
 * decides next; otherwise only a sentence split by the subtitles, with no
 * real pause, is joined.
 */
function joinsGroup(voiceover: Voiceover, group: Cue[], next: Cue): boolean {
  const prev = group[group.length - 1];
  if (castKey(prev) !== castKey(next) || (prev.mode ?? "") !== (next.mode ?? "")) return false;
  const chars = [...group, next].reduce((n, c) => n + renderLine(voiceover, c).text.length, 0);
  if (next.end - group[0].start > GROUP_MAX_SPAN || chars > GROUP_MAX_CHARS) return false;
  const override = voiceover.joins[prev.id];
  if (override) return override === "join";
  return next.start - prev.end <= GROUP_MAX_GAP && !endsSentence(voiceover, prev);
}

/** The cues with something to say, as the lines they are spoken in. */
export function lineGroups(voiceover: Voiceover, cues: Cue[]): Cue[][] {
  const groups: Cue[][] = [];
  for (const cue of sortCues(cues)) {
    if (!hasSomethingToSay(voiceover, cue)) continue;
    const current = groups[groups.length - 1];
    if (current && joinsGroup(voiceover, current, cue)) current.push(cue);
    else groups.push([cue]);
  }
  return groups;
}

/** Sets or clears the grouping override at the boundary after `cueId`. */
export function setJoin(
  voiceover: Voiceover,
  cueId: string,
  join: "join" | "split" | undefined,
): Voiceover {
  const joins = { ...voiceover.joins };
  if (join) joins[cueId] = join;
  else delete joins[cueId];
  return { ...voiceover, joins };
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * The lines of a project and their state, worked out once. Every question
 * about lines goes through this, so the Cast panel, the timeline and the
 * generator can never disagree about what belongs together.
 */
export interface LineIndex {
  groups: Cue[][];
  /** The line a cue is spoken in. */
  groupOf: (cueId: string) => Cue[] | undefined;
  stateOf: (group: Cue[]) => LineState;
  /** A generated clip whose cues, text or voice have changed, or gone. */
  isStale: (clip: VoiceClip) => boolean;
  /** Lines that are missing or out of date. */
  pending: Cue[][];
}

export function lineIndex(voiceover: Voiceover, cues: Cue[]): LineIndex {
  const groups = lineGroups(voiceover, cues);
  const byCue = new Map<string, Cue[]>();
  for (const group of groups) for (const cue of group) byCue.set(cue.id, group);

  const stateOf = (group: Cue[]): LineState => {
    const clip = clipForCue(voiceover, group[0].id);
    if (!clip?.source) return "missing";
    const line = renderGroup(voiceover, group);
    const fresh =
      sameIds(clip.source.cueIds, group.map((c) => c.id)) &&
      clip.source.text === line.text &&
      clip.source.voiceKey === renderedKey(line);
    return fresh ? "current" : "stale";
  };

  const isStale = (clip: VoiceClip): boolean => {
    if (!clip.source) return false;
    const group = byCue.get(clip.source.cueIds[0]);
    if (!group || clipForCue(voiceover, group[0].id) !== clip) return true;
    return stateOf(group) !== "current";
  };

  return {
    groups,
    groupOf: (cueId) => byCue.get(cueId),
    stateOf,
    isStale,
    pending: groups.filter((g) => stateOf(g) !== "current"),
  };
}

/** Seconds the clip runs past the end of its last cue; 0 when it fits. */
export function overrun(clip: VoiceClip, cues: Cue[]): number {
  if (!clip.source) return 0;
  const own = cues.filter((c) => clip.source!.cueIds.includes(c.id));
  if (own.length === 0) return 0;
  const over = clipEnd(clip) - Math.max(...own.map((c) => c.end));
  return over > OVERRUN_TOLERANCE ? over : 0;
}

/**
 * The voice track a speaker's lines land on: theirs if it still exists,
 * otherwise the first voice track, otherwise a new one.
 */
export function trackForVoice(
  voiceover: Voiceover,
  key: string,
): { voiceover: Voiceover; trackId: string } {
  const tracks = voiceTracks(voiceover);
  const wanted = voiceFor(voiceover, key).trackId;
  const own = tracks.find((t) => t.id === wanted);
  if (own) return { voiceover, trackId: own.id };
  if (tracks.length > 0) return { voiceover, trackId: tracks[0].id };
  const withTrack = addTrack(voiceover);
  return { voiceover: withTrack, trackId: voiceTracks(withTrack)[0].id };
}

/**
 * Places a freshly generated take of a line. The clip already holding the
 * line's first cue gets the take — keeping where it was moved to, its track
 * and its gain — and plays it untrimmed; otherwise a new clip starts at the
 * line's first cue. Any other clip that only held cues of this line is
 * removed: the new line speaks those words now. `line` is what was actually
 * spoken; it defaults to the line as it reads now.
 */
export function placeTake(
  voiceover: Voiceover,
  group: Cue[],
  take: ClipTake,
  line: RenderedLine = renderGroup(voiceover, group),
): Voiceover {
  const ids = group.map((c) => c.id);
  const source = { cueIds: ids, text: line.text, voiceKey: renderedKey(line) };
  const existing = clipForCue(voiceover, ids[0]);
  const superseded = (c: VoiceClip) =>
    c !== existing && !!c.source && c.source.cueIds.every((id) => ids.includes(id));
  const clips = voiceover.clips.filter((c) => !superseded(c));

  if (existing) {
    const takes = [...(existing.takes ?? []), take];
    return {
      ...voiceover,
      clips: clips.map((c) =>
        c.id === existing.id
          ? {
              ...c,
              file: take.file,
              offset: 0,
              duration: take.duration,
              sourceDuration: take.duration,
              source,
              takes,
            }
          : c,
      ),
    };
  }

  const placed = trackForVoice({ ...voiceover, clips }, castKey(group[0]));
  const clip: VoiceClip = {
    id: makeId(),
    trackId: placed.trackId,
    file: take.file,
    // Named after the subtitles, not the script: tags make poor labels.
    name: clipName(group.map(speechText).join(" ") || stripTags(source.text)),
    start: group[0].start,
    offset: 0,
    duration: take.duration,
    sourceDuration: take.duration,
    gainDb: 0,
    source,
    takes: [take],
  };
  return { ...placed.voiceover, clips: [...placed.voiceover.clips, clip] };
}

/** Switches a clip to another of its takes, untrimmed. */
export function selectTake(voiceover: Voiceover, clipId: string, index: number): Voiceover {
  return {
    ...voiceover,
    clips: voiceover.clips.map((c) => {
      const take = c.takes?.[index];
      if (c.id !== clipId || !take || c.file === take.file) return c;
      return {
        ...c,
        file: take.file,
        offset: 0,
        duration: take.duration,
        sourceDuration: take.duration,
      };
    }),
  };
}

/**
 * Where each cue's words fall in a take, when alignment did not say: shares
 * of the take in proportion to each cue's text. Rough, but never empty.
 */
export function proportionalMarks(parts: string[], duration: number): Array<[number, number]> {
  const weights = parts.map((p) => Math.max(1, stripTags(p).length));
  const total = weights.reduce((a, b) => a + b, 0);
  let at = 0;
  return weights.map((w) => {
    const start = at;
    at += (w / total) * duration;
    return [start, at];
  });
}

/**
 * Retimes cues to their generated lines, so each subtitle shows while its
 * words are spoken: a single cue spans its whole clip, the cues of a joined
 * line span their own words (aligned when the take was made, proportional
 * otherwise). Only the timing changes; each cue stays inside the room its
 * neighbours leave it (with `minGap`). `ids` limits which cues move; by
 * default every cue that has a line does.
 */
export function fitCuesToLines(
  cues: Cue[],
  voiceover: Voiceover,
  duration: number,
  minGap: number,
  ids?: Set<string>,
): Cue[] {
  const targets = new Map<string, [number, number]>();
  for (const clip of voiceover.clips) {
    const cueIds = clip.source?.cueIds;
    if (!cueIds?.length) continue;
    if (cueIds.length === 1) {
      targets.set(cueIds[0], [clip.start, clipEnd(clip)]);
      continue;
    }
    const take = clip.takes?.find((t) => t.file === clip.file);
    const marks =
      take?.marks?.length === cueIds.length
        ? take.marks
        : proportionalMarks(
            cueIds.map((id) => {
              const cue = cues.find((c) => c.id === id);
              return cue ? renderLine(voiceover, cue).text : "";
            }),
            clip.sourceDuration,
          );
    cueIds.forEach((id, i) => {
      const [from, to] = marks[i];
      const start = Math.max(clip.start, clip.start + from - clip.offset);
      const end = Math.min(clipEnd(clip), clip.start + to - clip.offset);
      if (end > start) targets.set(id, [start, end]);
    });
  }

  // Each cue is clamped by its neighbours as they stand, so the order matters:
  // cues moving left go first to last, cues moving right last to first, so a
  // cue never runs into a neighbour that is about to move out of its way.
  const moving = sortCues(cues).filter(
    (cue) => (!ids || ids.has(cue.id)) && targets.has(cue.id),
  );
  const leftward = moving.filter((cue) => targets.get(cue.id)![0] <= cue.start);
  const rightward = moving.filter((cue) => targets.get(cue.id)![0] > cue.start).reverse();
  let next = cues;
  for (const cue of [...leftward, ...rightward]) {
    const [start, end] = targets.get(cue.id)!;
    next = resizeCue(next, cue.id, start, end, duration, minGap);
  }
  return next;
}

/**
 * Drops one take. Deleting the take in use switches to its neighbour (the
 * next, else the previous), untrimmed; deleting the only take removes the
 * clip. The audio file is left on disk: undo can bring the take back.
 */
export function removeTake(voiceover: Voiceover, clipId: string, index: number): Voiceover {
  const clip = voiceover.clips.find((c) => c.id === clipId);
  const takes = clip?.takes;
  if (!clip || !takes || index < 0 || index >= takes.length) return voiceover;
  if (takes.length === 1) {
    return { ...voiceover, clips: voiceover.clips.filter((c) => c.id !== clipId) };
  }
  const remaining = takes.filter((_, i) => i !== index);
  let next: VoiceClip = { ...clip, takes: remaining };
  if (takes[index].file === clip.file) {
    const take = remaining[Math.min(index, remaining.length - 1)];
    next = {
      ...next,
      file: take.file,
      offset: 0,
      duration: take.duration,
      sourceDuration: take.duration,
    };
  }
  return { ...voiceover, clips: voiceover.clips.map((c) => (c.id === clipId ? next : c)) };
}

/**
 * The cues a reference is suggested from, before anyone has chosen: the
 * speaker's longest spoken lines, so a few good lines beat many fragments,
 * until there is enough. Thoughts are left out, since they are not the
 * character's audible voice.
 */
export function suggestedReferenceCues(cues: Cue[], key: string): Cue[] {
  const candidates = cues
    .filter((c) => castKey(c) === key && c.mode !== "thought" && speechText(c) !== "")
    .sort((a, b) => b.end - b.start - (a.end - a.start));
  const picked: Cue[] = [];
  let total = 0;
  for (const cue of candidates) {
    if (total >= REFERENCE_TARGET_SECONDS) break;
    if (cue.end - cue.start <= 0.3) continue;
    picked.push(cue);
    total += cue.end - cue.start;
  }
  return sortCues(picked);
}

/** The stretches of video to cut a reference from, capped in total length. */
export function referenceSegments(chosen: Cue[]): Array<[number, number]> {
  const segments: Array<[number, number]> = [];
  let total = 0;
  for (const cue of sortCues(chosen)) {
    const length = Math.min(cue.end - cue.start, REFERENCE_MAX_SECONDS - total);
    if (length <= 0) break;
    segments.push([cue.start, cue.start + length]);
    total += length;
  }
  return segments;
}

/** A new random seed; a take records it so it can be reproduced. */
export function newSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/** Where a generated take is written: beside the video, one folder per video. */
export function takePath(dir: string, stem: string, cueId: string, seed: number): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${dir}${sep}${stem}.voiceover${sep}${cueId.slice(0, 8)}-${seed}.wav`;
}

export function referencePath(dir: string, stem: string, key: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  const name = key === NO_SPEAKER ? "unassigned" : key.slice(0, 8);
  return `${dir}${sep}${stem}.voiceover${sep}reference-${name}-${Date.now().toString(36)}.wav`;
}

function clipName(text: string): string {
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}
