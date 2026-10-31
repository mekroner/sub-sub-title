/**
 * The `.sstproj` project file: cues, speakers, and a *reference* to the video.
 * The video itself is never copied, so a project is small and moves freely —
 * at the cost of breaking if the video is renamed, which the app reports.
 */

import type {
  CastVoice,
  ClipSource,
  ClipTake,
  TakeCheck,
  Cue,
  CueVoicing,
  DuckSettings,
  TtsEngine,
  GainPoint,
  Project,
  ProjectFile,
  Section,
  Speaker,
  TimedBeat,
  VoiceClip,
  VoiceTrack,
  Voiceover,
} from "../types";
import { sortCues } from "./cues";
import { DEFAULT_VOICE } from "./tts";
import { makeId } from "./ids";
import {
  DEFAULT_DUCK,
  MAX_VOICE_TRACKS,
  ORIGINAL_TRACK_ID,
  basename,
  clampDb,
  defaultVoiceover,
  originalTrack,
  patchDuck,
} from "./voiceover";
import { sortSections } from "./sections";
import { sortBeats } from "./timedBeats";

export const PROJECT_EXTENSION = "sstproj";

export function serializeProjectFile(project: Project): string {
  const file: ProjectFile = {
    version: 1,
    savedAt: new Date().toISOString(),
    ...project,
  };
  return JSON.stringify(file, null, 2);
}

/** Basename without the extension — the project's display name. */
export function projectName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}

function coerceCue(raw: unknown): Cue | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Partial<Cue>;
  const start = Number(c.start);
  const end = Number(c.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return {
    id: typeof c.id === "string" && c.id ? c.id : makeId(),
    start,
    end,
    text: typeof c.text === "string" ? c.text : "",
    speakerId: typeof c.speakerId === "string" ? c.speakerId : null,
    // Absent stays absent, so a file written before modes existed survives a
    // load/save cycle unchanged.
    ...(c.mode === "thought" ? { mode: "thought" as const } : {}),
  };
}

function coerceSpeaker(raw: unknown): Speaker | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Partial<Speaker>;
  if (typeof s.name !== "string") return null;
  return {
    id: typeof s.id === "string" && s.id ? s.id : makeId(),
    name: s.name,
    color: typeof s.color === "string" ? s.color : "#888888",
    ...(typeof s.thinkingColor === "string" ? { thinkingColor: s.thinkingColor } : {}),
    ...(typeof s.voiceNotes === "string" ? { voiceNotes: s.voiceNotes } : {}),
    ...(typeof s.innerVoice === "string" ? { innerVoice: s.innerVoice } : {}),
  };
}

function coerceTimedBeat(raw: unknown): TimedBeat | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Partial<TimedBeat>;
  // A beat needs a moment and something to say; anything else is noise.
  if (typeof b.time !== "number" || !Number.isFinite(b.time)) return null;
  if (typeof b.text !== "string" || b.text.trim() === "") return null;
  return {
    id: typeof b.id === "string" && b.id ? b.id : makeId(),
    time: Math.max(0, b.time),
    text: b.text,
    ...(b.by === "agent" ? { by: "agent" as const } : {}),
  };
}

function coerceSection(raw: unknown): Section | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Partial<Section>;
  // A flag with no time cannot be placed on the timeline, so it is dropped.
  if (typeof s.start !== "number" || !Number.isFinite(s.start)) return null;
  return {
    id: typeof s.id === "string" && s.id ? s.id : makeId(),
    start: Math.max(0, s.start),
    // An unnamed flag is still a usable mark; it shows as a bare line.
    label: typeof s.label === "string" ? s.label : "",
    ...(typeof s.note === "string" && s.note.trim() !== "" ? { note: s.note } : {}),
  };
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function coerceGainPoint(raw: unknown): GainPoint | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Partial<GainPoint>;
  if (typeof p.time !== "number" || !Number.isFinite(p.time)) return null;
  return { time: Math.max(0, p.time), db: clampDb(finite(p.db, 0)) };
}

function coerceTrack(raw: unknown): VoiceTrack | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Partial<VoiceTrack>;
  if (t.kind !== "original" && t.kind !== "voice") return null;
  return {
    id: t.kind === "original" ? ORIGINAL_TRACK_ID : typeof t.id === "string" && t.id ? t.id : makeId(),
    kind: t.kind,
    name: typeof t.name === "string" ? t.name : t.kind === "original" ? "Original" : "VO",
    gainDb: clampDb(finite(t.gainDb, 0)),
    muted: t.muted === true,
    solo: t.solo === true,
    automation: Array.isArray(t.automation)
      ? t.automation
          .map(coerceGainPoint)
          .filter((p): p is GainPoint => p !== null)
          .sort((a, b) => a.time - b.time)
      : [],
  };
}

function coerceClip(raw: unknown): VoiceClip | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Partial<VoiceClip>;
  // Without a file or a place on a track there is nothing to play.
  if (typeof c.file !== "string" || !c.file) return null;
  if (typeof c.trackId !== "string") return null;
  const sourceDuration = finite(c.sourceDuration, 0);
  const offset = Math.min(Math.max(0, finite(c.offset, 0)), sourceDuration);
  const duration = Math.min(finite(c.duration, 0), sourceDuration - offset);
  if (!(duration > 0)) return null;
  return {
    id: typeof c.id === "string" && c.id ? c.id : makeId(),
    trackId: c.trackId,
    file: c.file,
    name: typeof c.name === "string" ? c.name : basename(c.file),
    start: Math.max(0, finite(c.start, 0)),
    offset,
    duration,
    sourceDuration,
    gainDb: clampDb(finite(c.gainDb, 0)),
    ...coerceSource(c.source),
    ...coerceTakes(c.takes),
  };
}

function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string" && s !== "") : [];
}

function coerceSource(raw: unknown): { source?: ClipSource } {
  if (typeof raw !== "object" || raw === null) return {};
  // `cueId` is how files written before lines could span cues name the cue.
  const s = raw as Partial<ClipSource> & { cueId?: unknown };
  const cueIds = strings(s.cueIds);
  if (cueIds.length === 0 && typeof s.cueId === "string" && s.cueId) cueIds.push(s.cueId);
  if (cueIds.length === 0 || typeof s.text !== "string") return {};
  return {
    source: {
      cueIds,
      text: s.text,
      voiceKey: typeof s.voiceKey === "string" ? s.voiceKey : "",
    },
  };
}

function coerceMarks(raw: unknown): { marks?: Array<[number, number]> } {
  if (!Array.isArray(raw)) return {};
  const marks = raw.filter(
    (m): m is [number, number] =>
      Array.isArray(m) &&
      m.length === 2 &&
      typeof m[0] === "number" &&
      typeof m[1] === "number" &&
      Number.isFinite(m[0]) &&
      Number.isFinite(m[1]),
  );
  // A partial list would pair marks with the wrong cues; all or nothing.
  return marks.length && marks.length === raw.length ? { marks } : {};
}

/** A speech window inside the take, or nothing: a bad one would play the wrong part. */
function coerceSpeech(raw: unknown, duration: number): { speech?: [number, number] } {
  if (!Array.isArray(raw) || raw.length !== 2) return {};
  const [from, to] = raw;
  if (typeof from !== "number" || typeof to !== "number") return {};
  return from >= 0 && to > from && to <= duration + 1e-6 ? { speech: [from, to] } : {};
}

function coerceCheck(raw: unknown): { check?: TakeCheck } {
  if (typeof raw !== "object" || raw === null) return {};
  const c = raw as Partial<TakeCheck>;
  return Number.isFinite(c.score) && Number.isFinite(c.rate)
    ? { check: { score: c.score as number, rate: c.rate as number } }
    : {};
}

function coerceTakes(raw: unknown): { takes?: ClipTake[] } {
  if (!Array.isArray(raw)) return {};
  const takes = raw.flatMap((t): ClipTake[] => {
    if (typeof t !== "object" || t === null) return [];
    const take = t as Partial<ClipTake>;
    if (typeof take.file !== "string" || !take.file) return [];
    const duration = finite(take.duration, 0);
    return duration > 0
      ? [
          {
            file: take.file,
            seed: finite(take.seed, 0),
            duration,
            ...coerceMarks(take.marks),
            ...coerceSpeech(take.speech, duration),
            ...coerceCheck(take.check),
          },
        ]
      : [];
  });
  return takes.length ? { takes } : {};
}

function coerceJoins(raw: unknown): Record<string, "join" | "split"> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const joins: Record<string, "join" | "split"> = {};
  for (const [cueId, value] of Object.entries(raw)) {
    if (value === "join" || value === "split") joins[cueId] = value;
  }
  return joins;
}

/** Keeps only entries that still say something; a blank field is dropped. */
function coerceVoicing(raw: unknown): Record<string, CueVoicing> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const voicing: Record<string, CueVoicing> = {};
  for (const [cueId, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Partial<CueVoicing>;
    const entry: CueVoicing = {
      ...(typeof v.spoken === "string" && v.spoken.trim() ? { spoken: v.spoken } : {}),
      ...(typeof v.direction === "string" && v.direction.trim() ? { direction: v.direction } : {}),
    };
    if (entry.spoken !== undefined || entry.direction !== undefined) voicing[cueId] = entry;
  }
  return voicing;
}

const ENGINES: TtsEngine[] = ["turbo", "standard"];

function coerceCast(raw: unknown): Record<string, CastVoice> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const cast: Record<string, CastVoice> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Partial<CastVoice>;
    cast[key] = {
      engine: ENGINES.includes(v.engine as TtsEngine) ? (v.engine as TtsEngine) : DEFAULT_VOICE.engine,
      exaggeration: Math.min(2, Math.max(0.25, finite(v.exaggeration, DEFAULT_VOICE.exaggeration))),
      cfgWeight: Math.min(1, Math.max(0, finite(v.cfgWeight, DEFAULT_VOICE.cfgWeight))),
      temperature: Math.min(1.5, Math.max(0.05, finite(v.temperature, DEFAULT_VOICE.temperature))),
      ...(typeof v.reference === "string" && v.reference ? { reference: v.reference } : {}),
      ...(typeof v.trackId === "string" && v.trackId ? { trackId: v.trackId } : {}),
      ...(strings(v.referenceCueIds).length ? { referenceCueIds: strings(v.referenceCueIds) } : {}),
    };
  }
  return cast;
}

/**
 * Always yields exactly one original track, first, and at most the allowed
 * number of voice tracks; clips on a track that did not survive are dropped.
 */
function coerceVoiceover(raw: unknown): Voiceover {
  if (typeof raw !== "object" || raw === null) return defaultVoiceover();
  const v = raw as Partial<Voiceover>;
  const tracks = Array.isArray(v.tracks)
    ? v.tracks.map(coerceTrack).filter((t): t is VoiceTrack => t !== null)
    : [];
  const original = tracks.find((t) => t.kind === "original") ?? originalTrack();
  // Duplicate ids would make two lanes answer to one clip.
  const seen = new Set<string>([ORIGINAL_TRACK_ID]);
  const voices: VoiceTrack[] = [];
  for (const t of tracks) {
    if (t.kind !== "voice" || seen.has(t.id)) continue;
    seen.add(t.id);
    voices.push(t);
  }
  voices.splice(MAX_VOICE_TRACKS);
  const voiceIds = new Set(voices.map((t) => t.id));
  const clips = Array.isArray(v.clips)
    ? v.clips
        .map(coerceClip)
        .filter((c): c is VoiceClip => c !== null && voiceIds.has(c.trackId))
    : [];
  const rawDuck =
    typeof v.duck === "object" && v.duck !== null ? (v.duck as Partial<DuckSettings>) : {};
  // patchDuck clamps every field, so a hand-edited value cannot escape the range.
  const withDuck = patchDuck(
    {
      tracks: [original, ...voices],
      clips,
      duck: { ...DEFAULT_DUCK },
      unduckedCueIds: [],
      cast: coerceCast(v.cast),
      voicing: coerceVoicing(v.voicing),
      joins: coerceJoins(v.joins),
    },
    {
      enabled: rawDuck.enabled !== false,
      depthDb: finite(rawDuck.depthDb, DEFAULT_DUCK.depthDb),
      attack: finite(rawDuck.attack, DEFAULT_DUCK.attack),
      release: finite(rawDuck.release, DEFAULT_DUCK.release),
      bridge: finite(rawDuck.bridge, DEFAULT_DUCK.bridge),
    },
  );
  const unduckedCueIds = Array.isArray(v.unduckedCueIds)
    ? [...new Set(v.unduckedCueIds.filter((id): id is string => typeof id === "string" && id !== ""))]
    : [];
  return { ...withDuck, unduckedCueIds };
}

/**
 * Tolerant of hand-edited and partial files: anything unusable is dropped
 * rather than failing the whole load. Only unparseable JSON throws.
 */
export function parseProjectFile(raw: string): Project {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("That project file is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("That project file is empty or malformed.");
  }

  const file = parsed as Partial<ProjectFile>;
  const cues = Array.isArray(file.cues)
    ? file.cues.map(coerceCue).filter((c): c is Cue => c !== null)
    : [];
  const speakers = Array.isArray(file.speakers)
    ? file.speakers.map(coerceSpeaker).filter((s): s is Speaker => s !== null)
    : [];

  // Written only since spellcheck existed, and hand-editable, so anything that
  // is not a non-empty string is dropped rather than failing the load.
  const dictionary = Array.isArray(file.dictionary)
    ? file.dictionary
        .filter((word): word is string => typeof word === "string")
        .map((word) => word.trim())
        .filter(Boolean)
    : [];

  // Unlike the dictionary, blank entries are kept: they are the paragraph
  // breaks the writer typed between beats, and dropping them would rewrite the
  // outline on every save. Blanks are filtered where the beats are used.
  const beats = Array.isArray(file.beats)
    ? file.beats.filter((beat): beat is string => typeof beat === "string")
    : [];

  const sections = Array.isArray(file.sections)
    ? sortSections(
        file.sections.map(coerceSection).filter((s): s is Section => s !== null),
      )
    : [];

  // Written only since timed beats existed; older files simply have none.
  const timedBeats = Array.isArray(file.timedBeats)
    ? sortBeats(file.timedBeats.map(coerceTimedBeat).filter((b): b is TimedBeat => b !== null))
    : [];

  return {
    videoPath: typeof file.videoPath === "string" ? file.videoPath : "",
    cues: sortCues(cues),
    speakers,
    dictionary,
    brief: typeof file.brief === "string" ? file.brief : "",
    beats,
    sections,
    timedBeats,
    // Written only since the Voiceover tab existed; older files get the
    // original track alone.
    voiceover: coerceVoiceover(file.voiceover),
  };
}
