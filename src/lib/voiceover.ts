/**
 * The voiceover mix: tracks, clips, and the rules between them. Pure functions
 * over `Voiceover`, so every edit is one undoable project update.
 */

import type { DuckSettings, GainPoint, VoiceClip, VoiceTrack, Voiceover } from "../types";
import { makeId } from "./ids";

/** The original track plus this many voice tracks, and no more. */
export const MAX_VOICE_TRACKS = 5;
export const ORIGINAL_TRACK_ID = "original";
/** A trim can shorten a clip to this and no further, so it stays grabbable. */
export const MIN_CLIP_SECONDS = 0.05;
/** Below this the gain is treated as silence. */
export const MIN_DB = -60;
export const MAX_DB = 12;

/** Loudness targets an export or render can be brought to, in LUFS. */
export const LOUDNESS_TARGETS = [
  { lufs: -16, label: "−16 LUFS — web and podcasts" },
  { lufs: -23, label: "−23 LUFS — broadcast (EBU R128)" },
] as const;

export function originalTrack(): VoiceTrack {
  return {
    id: ORIGINAL_TRACK_ID,
    kind: "original",
    name: "Original",
    gainDb: 0,
    muted: false,
    solo: false,
    automation: [],
  };
}

export const DEFAULT_DUCK: DuckSettings = {
  enabled: true,
  depthDb: -15,
  attack: 0.15,
  release: 0.35,
  bridge: 0.6,
};

export function defaultVoiceover(): Voiceover {
  return {
    tracks: [originalTrack()],
    clips: [],
    duck: { ...DEFAULT_DUCK },
    unduckedCueIds: [],
    cast: {},
    voicing: {},
    joins: {},
  };
}

export function patchDuck(voiceover: Voiceover, patch: Partial<DuckSettings>): Voiceover {
  const next = { ...voiceover.duck, ...patch };
  next.depthDb = Math.min(0, clampDb(next.depthDb));
  next.attack = Math.max(0, finiteOr(next.attack, DEFAULT_DUCK.attack));
  next.release = Math.max(0, finiteOr(next.release, DEFAULT_DUCK.release));
  next.bridge = Math.max(0, finiteOr(next.bridge, DEFAULT_DUCK.bridge));
  const changed = (Object.keys(next) as Array<keyof DuckSettings>).some(
    (k) => next[k] !== voiceover.duck[k],
  );
  return changed ? { ...voiceover, duck: next } : voiceover;
}

export function isCueDucked(voiceover: Voiceover, cueId: string): boolean {
  return !voiceover.unduckedCueIds.includes(cueId);
}

export function toggleCueDuck(voiceover: Voiceover, cueId: string): Voiceover {
  const unduckedCueIds = isCueDucked(voiceover, cueId)
    ? [...voiceover.unduckedCueIds, cueId]
    : voiceover.unduckedCueIds.filter((id) => id !== cueId);
  return { ...voiceover, unduckedCueIds };
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function voiceTracks(voiceover: Voiceover): VoiceTrack[] {
  return voiceover.tracks.filter((t) => t.kind === "voice");
}

export function canAddTrack(voiceover: Voiceover): boolean {
  return voiceTracks(voiceover).length < MAX_VOICE_TRACKS;
}

/** Unused "VO n" name, so removing VO 2 and adding again does not repeat VO 3. */
function nextTrackName(voiceover: Voiceover): string {
  const taken = new Set(voiceover.tracks.map((t) => t.name));
  for (let n = 1; ; n++) {
    const name = `VO ${n}`;
    if (!taken.has(name)) return name;
  }
}

export function addTrack(voiceover: Voiceover): Voiceover {
  if (!canAddTrack(voiceover)) return voiceover;
  const track: VoiceTrack = {
    id: makeId(),
    kind: "voice",
    name: nextTrackName(voiceover),
    gainDb: 0,
    muted: false,
    solo: false,
    automation: [],
  };
  return { ...voiceover, tracks: [...voiceover.tracks, track] };
}

/** Removes a voice track and every clip on it. The original cannot be removed. */
export function removeTrack(voiceover: Voiceover, id: string): Voiceover {
  const track = voiceover.tracks.find((t) => t.id === id);
  if (!track || track.kind === "original") return voiceover;
  return {
    ...voiceover,
    tracks: voiceover.tracks.filter((t) => t.id !== id),
    clips: voiceover.clips.filter((c) => c.trackId !== id),
  };
}

export type TrackPatch = Partial<Pick<VoiceTrack, "name" | "gainDb" | "muted" | "solo">>;

export function patchTrack(voiceover: Voiceover, id: string, patch: TrackPatch): Voiceover {
  let changed = false;
  const tracks = voiceover.tracks.map((t) => {
    if (t.id !== id) return t;
    const next = { ...t, ...patch };
    if (next.gainDb !== t.gainDb) next.gainDb = clampDb(next.gainDb);
    changed = (Object.keys(patch) as Array<keyof TrackPatch>).some((k) => next[k] !== t[k]);
    return next;
  });
  return changed ? { ...voiceover, tracks } : voiceover;
}

/** Replaces a track's gain curve. */
export function setAutomation(voiceover: Voiceover, id: string, points: GainPoint[]): Voiceover {
  const track = voiceover.tracks.find((t) => t.id === id);
  if (!track || track.automation === points) return voiceover;
  return {
    ...voiceover,
    tracks: voiceover.tracks.map((t) => (t.id === id ? { ...t, automation: points } : t)),
  };
}

/**
 * Whether a track is heard. Any solo silences every track not soloed, the
 * original included, which is how a mixing desk behaves.
 */
export function isAudible(voiceover: Voiceover, track: VoiceTrack): boolean {
  const anySolo = voiceover.tracks.some((t) => t.solo);
  return anySolo ? track.solo : !track.muted;
}

export function clampDb(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.min(MAX_DB, Math.max(MIN_DB, db));
}

/** Linear amplitude for a gain in dB, with the floor meaning true silence. */
export function dbToGain(db: number): number {
  return db <= MIN_DB ? 0 : Math.pow(10, db / 20);
}

export function clipEnd(clip: VoiceClip): number {
  return clip.start + clip.duration;
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function newClip(
  trackId: string,
  file: string,
  start: number,
  sourceDuration: number,
): VoiceClip {
  return {
    id: makeId(),
    trackId,
    file,
    name: basename(file).replace(/\.[^.]+$/, ""),
    start: Math.max(0, start),
    offset: 0,
    duration: sourceDuration,
    sourceDuration,
    gainDb: 0,
  };
}

/** Adds clips to a voice track; anything aimed elsewhere is dropped. */
export function addClips(voiceover: Voiceover, clips: VoiceClip[]): Voiceover {
  const voiceIds = new Set(voiceTracks(voiceover).map((t) => t.id));
  const accepted = clips.filter((c) => voiceIds.has(c.trackId));
  if (accepted.length === 0) return voiceover;
  return { ...voiceover, clips: [...voiceover.clips, ...accepted] };
}

export function removeClip(voiceover: Voiceover, id: string): Voiceover {
  const clips = voiceover.clips.filter((c) => c.id !== id);
  return clips.length === voiceover.clips.length ? voiceover : { ...voiceover, clips };
}

export type ClipPatch = Partial<Pick<VoiceClip, "name" | "gainDb">>;

export function patchClip(voiceover: Voiceover, id: string, patch: ClipPatch): Voiceover {
  return mapClip(voiceover, id, (c) => {
    const next = { ...c, ...patch };
    if (next.gainDb !== c.gainDb) next.gainDb = clampDb(next.gainDb);
    return next;
  });
}

/** Moves a clip in time and, optionally, onto another voice track. */
export function moveClip(
  voiceover: Voiceover,
  id: string,
  start: number,
  trackId?: string,
): Voiceover {
  const target =
    trackId === undefined ? undefined : voiceTracks(voiceover).find((t) => t.id === trackId);
  return mapClip(voiceover, id, (c) => ({
    ...c,
    start: Math.max(0, start),
    trackId: target ? target.id : c.trackId,
  }));
}

/**
 * Moves several clips by the same amount, keeping their tracks and spacing.
 * The block stops at the timeline's zero rather than squashing against it;
 * returns the amount actually moved alongside the result, so cues moved with
 * the clips can stop where they do.
 */
export function moveClipsBy(
  voiceover: Voiceover,
  ids: Set<string>,
  delta: number,
): { voiceover: Voiceover; delta: number } {
  const moving = voiceover.clips.filter((c) => ids.has(c.id));
  if (moving.length === 0 || delta === 0) return { voiceover, delta: 0 };
  const applied = Math.max(delta, -Math.min(...moving.map((c) => c.start)));
  if (applied === 0) return { voiceover, delta: 0 };
  return {
    voiceover: {
      ...voiceover,
      clips: voiceover.clips.map((c) => (ids.has(c.id) ? { ...c, start: c.start + applied } : c)),
    },
    delta: applied,
  };
}

/**
 * Moves the clip's head to `start`, revealing or hiding the start of the file
 * while its tail stays put. Clamped to the file and to the timeline's zero.
 */
export function trimClipStart(voiceover: Voiceover, id: string, start: number): Voiceover {
  return mapClip(voiceover, id, (c) => {
    const end = clipEnd(c);
    const earliest = Math.max(0, c.start - c.offset);
    const next = Math.min(end - MIN_CLIP_SECONDS, Math.max(earliest, start));
    const shift = next - c.start;
    return { ...c, start: next, offset: c.offset + shift, duration: c.duration - shift };
  });
}

/** Moves the clip's tail to `end`, within the file. */
export function trimClipEnd(voiceover: Voiceover, id: string, end: number): Voiceover {
  return mapClip(voiceover, id, (c) => {
    const longest = c.sourceDuration - c.offset;
    const duration = Math.min(longest, Math.max(MIN_CLIP_SECONDS, end - c.start));
    return { ...c, duration };
  });
}

/** Applies `fn` to one clip; returns the same object when nothing changed. */
function mapClip(
  voiceover: Voiceover,
  id: string,
  fn: (clip: VoiceClip) => VoiceClip,
): Voiceover {
  let changed = false;
  const clips = voiceover.clips.map((c) => {
    if (c.id !== id) return c;
    const next = fn(c);
    changed = (Object.keys(next) as Array<keyof VoiceClip>).some((k) => next[k] !== c[k]);
    return changed ? next : c;
  });
  return changed ? { ...voiceover, clips } : voiceover;
}

/**
 * Snaps `time` to the nearest candidate within `tolerance` seconds, or returns
 * it unchanged. Used while dragging clips onto cue boundaries and the playhead.
 */
export function snapTime(time: number, candidates: number[], tolerance: number): number {
  let best = time;
  let bestDistance = tolerance;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - time);
    if (distance <= bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
