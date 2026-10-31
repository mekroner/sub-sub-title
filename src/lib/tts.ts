/**
 * Generated speech: who is voiced how, which clip belongs to which cue, and
 * when a clip no longer says what its cue does. Pure functions over
 * `Voiceover`, like the rest of the mix.
 */

import type { CastVoice, ClipTake, Cue, VoiceClip, Voiceover } from "../types";
import { resizeCue, sortCues } from "./cues";
import { makeId } from "./ids";
import { addTrack, clipEnd, voiceTracks } from "./voiceover";

/** Cast key for cues with no speaker. */
export const NO_SPEAKER = "";
/** A line running this far past its cue is worth a warning. */
export const OVERRUN_TOLERANCE = 0.05;
/** How much of a speaker's own audio makes a good cloning reference. */
export const REFERENCE_TARGET_SECONDS = 15;
export const REFERENCE_MAX_SECONDS = 25;

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

export function clipForCue(voiceover: Voiceover, cueId: string): VoiceClip | undefined {
  return voiceover.clips.find((c) => c.source?.cueId === cueId);
}

export type LineState = "missing" | "stale" | "current";

export function lineState(voiceover: Voiceover, cue: Cue): LineState {
  const clip = clipForCue(voiceover, cue.id);
  if (!clip?.source) return "missing";
  const fresh =
    clip.source.text === speechText(cue) &&
    clip.source.voiceKey === voiceKey(voiceFor(voiceover, castKey(cue)));
  return fresh ? "current" : "stale";
}

/** A generated clip whose cue has changed, gone, or been revoiced. */
export function isClipStale(voiceover: Voiceover, clip: VoiceClip, cues: Cue[]): boolean {
  if (!clip.source) return false;
  const cue = cues.find((c) => c.id === clip.source!.cueId);
  return !cue || lineState(voiceover, cue) === "stale";
}

/** Seconds the clip runs past its cue's end; 0 when it fits. */
export function overrun(clip: VoiceClip, cues: Cue[]): number {
  if (!clip.source) return 0;
  const cue = cues.find((c) => c.id === clip.source!.cueId);
  if (!cue) return 0;
  const over = clipEnd(clip) - cue.end;
  return over > OVERRUN_TOLERANCE ? over : 0;
}

/** Cues with something to say whose line is missing or out of date. */
export function pendingCues(voiceover: Voiceover, cues: Cue[]): Cue[] {
  return cues.filter((cue) => speechText(cue) !== "" && lineState(voiceover, cue) !== "current");
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
 * Places a freshly generated take. A cue that already has a clip gets the
 * take added to it — keeping where the clip was moved to, its track and its
 * gain — and plays it untrimmed; otherwise a new clip starts at the cue.
 */
export function placeTake(voiceover: Voiceover, cue: Cue, take: ClipTake): Voiceover {
  const key = castKey(cue);
  const source = {
    cueId: cue.id,
    text: speechText(cue),
    voiceKey: voiceKey(voiceFor(voiceover, key)),
  };
  const existing = clipForCue(voiceover, cue.id);
  if (existing) {
    const takes = [...(existing.takes ?? []), take];
    return {
      ...voiceover,
      clips: voiceover.clips.map((c) =>
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

  const placed = trackForVoice(voiceover, key);
  const clip: VoiceClip = {
    id: makeId(),
    trackId: placed.trackId,
    file: take.file,
    name: source.text.length > 40 ? `${source.text.slice(0, 39)}…` : source.text,
    start: cue.start,
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
 * Retimes cues to span their generated lines exactly, so the subtitle shows
 * while the voice speaks. Only the timing changes; each cue stays inside the
 * room its neighbours leave it (with `minGap`), so a line that overlaps the
 * next cue fits as far as it can. `ids` limits which cues move; by default
 * every cue that has a line does.
 */
export function fitCuesToLines(
  cues: Cue[],
  voiceover: Voiceover,
  duration: number,
  minGap: number,
  ids?: Set<string>,
): Cue[] {
  let next = cues;
  for (const cue of sortCues(cues)) {
    if (ids && !ids.has(cue.id)) continue;
    const clip = clipForCue(voiceover, cue.id);
    if (!clip) continue;
    next = resizeCue(next, cue.id, clip.start, clipEnd(clip), duration, minGap);
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
 * The stretches of a speaker's spoken lines to clone their voice from: the
 * longest first, so a few good lines beat many fragments, until there is
 * enough; then in story order. Thoughts are left out, since they are not the
 * character's audible voice.
 */
export function referenceSegments(cues: Cue[], key: string): Array<[number, number]> {
  const candidates = cues
    .filter((c) => castKey(c) === key && c.mode !== "thought" && speechText(c) !== "")
    .sort((a, b) => b.end - b.start - (a.end - a.start));
  const picked: Cue[] = [];
  let total = 0;
  for (const cue of candidates) {
    if (total >= REFERENCE_TARGET_SECONDS) break;
    const length = Math.min(cue.end - cue.start, REFERENCE_MAX_SECONDS - total);
    if (length <= 0.3) continue;
    picked.push({ ...cue, end: cue.start + length });
    total += length;
  }
  return picked.sort((a, b) => a.start - b.start).map((c) => [c.start, c.end]);
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
