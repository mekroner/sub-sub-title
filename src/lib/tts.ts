/**
 * Generated speech: who is voiced how, which cues are spoken as one line,
 * which clip holds each line, and when a clip no longer says what its cues
 * do. Pure functions over `Voiceover`, like the rest of the mix.
 */

import type { CastVoice, ClipTake, Cue, CueVoicing, VoiceClip, Voiceover } from "../types";
import { directionIntensity, directionTags, hasTag, stripTags } from "./direction";
import { resizeCue, sortCues } from "./cues";
import { speakable } from "./speakable";
import { makeId } from "./ids";
import { addTrack, canAddTrack, clipEnd, voiceTracks } from "./voiceover";

/** Cast key for cues with no speaker. */
export const NO_SPEAKER = "";
/** A line running this far past its last cue is worth a warning. */
export const OVERRUN_TOLERANCE = 0.05;
/**
 * How much of a speaker's own audio to cut for a cloning reference. More than
 * the 15 s the engine keeps: trimming each line to its speech, and leaving out
 * lines that are mostly music, shrinks it.
 */
export const REFERENCE_TARGET_SECONDS = 20;
export const REFERENCE_MAX_SECONDS = 30;

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
  preset: "female",
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
  if (next.takesPerLine === undefined) delete next.takesPerLine;
  return { ...voiceover, cast: { ...voiceover.cast, [key]: next } };
}

/** Who a voice is cloned from: its own reference, or else its built-in voice. */
export function voiceSource(voice: Pick<CastVoice, "reference" | "preset">): string {
  return voice.reference ?? `preset:${voice.preset}`;
}

/**
 * Everything about a voice that changes what it says. A clip spoken with a
 * different key is stale; the track it lands on is not part of it.
 */
export function voiceKey(voice: CastVoice): string {
  const parts: Array<string | number> = [voice.engine, voiceSource(voice), voice.temperature];
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
/**
 * Sets how `word` is said, or with an empty `spoken` forgets it. Lines with
 * the word go stale, as their spoken text changes.
 */
export function setPronunciation(voiceover: Voiceover, word: string, spoken: string): Voiceover {
  const key = word.trim();
  if (!key) return voiceover;
  const pronunciations = { ...voiceover.pronunciations };
  // One entry per word, whatever its case.
  for (const existing of Object.keys(pronunciations)) {
    if (existing.toLowerCase() === key.toLowerCase()) delete pronunciations[existing];
  }
  if (spoken.trim()) pronunciations[key] = spoken.trim();
  const next: Voiceover = { ...voiceover, pronunciations };
  if (!Object.keys(pronunciations).length) delete next.pronunciations;
  return next;
}

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
 * its own) with numbers and symbols spelled out and the project's
 * pronunciations applied, and the direction turned into tags for Turbo, or
 * into an intensity for Expressive — which reads tags aloud, so it gets none.
 */
export function renderLine(voiceover: Voiceover, cue: Cue): RenderedLine {
  const voice = voiceFor(voiceover, castKey(cue));
  const voicing = voicingFor(voiceover, cue.id);
  const base = speakable(speechText({ text: voicing.spoken ?? cue.text }), voiceover.pronunciations);
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

/**
 * Which of the queued lines to speak next, by index: one for the model last
 * used, with its reference if possible, otherwise the earliest. The engine
 * keeps one model on the GPU and swapping costs a reload, so a run where
 * speakers on different models take turns speaks each model's lines together.
 */
export function nextLine(
  voiceover: Voiceover,
  queue: Cue[][],
  last: Pick<CastVoice, "engine" | "reference" | "preset"> | null,
): number {
  let best = -1;
  let bestScore = -1;
  queue.forEach((group, i) => {
    const voice = voiceFor(voiceover, castKey(group[0]));
    const score = !last
      ? 0
      : voice.engine !== last.engine
        ? 0
        : voiceSource(voice) === voiceSource(last)
          ? 2
          : 1;
    if (score > bestScore || (score === bestScore && group[0].start < queue[best][0].start)) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

/**
 * A checked take whose words were found with less confidence than this has
 * likely dropped or garbled some. Forced alignment places every word
 * somewhere; a word that is not there is placed on whatever is nearby.
 * Measured on both Chatterbox models: good takes score 0.82 and up, takes
 * checked against words they do not say 0.45 and below. Lines of a word or
 * two are not checked at all (see the sidecar's `CHECK_MIN_LETTERS`).
 */
export const SUSPECT_SCORE = 0.6;
/**
 * Letters per second of speech outside this range is not how people talk: a
 * rushed take has skipped words, a slow one has stalled or added sounds.
 * Good takes measure about 9 to 17.
 */
export const SUSPECT_RATE: [number, number] = [4, 24];
/** The most takes a line can be spoken in at once. */
export const MAX_TAKES_PER_LINE = 3;

/** Whether a checked take probably does not say its line. Unchecked takes are not. */
export function isSuspect(take: ClipTake): boolean {
  if (!take.check) return false;
  const { score, rate } = take.check;
  return score < SUSPECT_SCORE || rate < SUSPECT_RATE[0] || rate > SUSPECT_RATE[1];
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
 * The most a take is sped up, counted from the take as spoken. Past this a
 * voice starts to sound processed, and a new take is the better fix.
 */
export const MAX_STRETCH = 1.2;

/** The take a clip is playing, if it has takes. */
export function currentTake(clip: VoiceClip): ClipTake | undefined {
  return clip.takes?.find((t) => t.file === clip.file);
}

/**
 * How much faster an overrunning clip must play to end with its last cue,
 * counted from the take as spoken; null when it does not overrun, has no
 * take, or would need more than `MAX_STRETCH`.
 */
export function fitRatio(clip: VoiceClip, cues: Cue[]): number | null {
  const take = currentTake(clip);
  if (!take || overrun(clip, cues) === 0) return null;
  const own = cues.filter((c) => clip.source!.cueIds.includes(c.id));
  const room = Math.max(...own.map((c) => c.end)) - clip.start;
  if (room <= 0) return null;
  // Rounded up a little, so the result lands inside the cue rather than on it.
  const ratio = Math.ceil(((take.stretch ?? 1) * clip.duration * 1000) / room) / 1000;
  return ratio <= MAX_STRETCH ? ratio : null;
}

/**
 * The take a stretch makes: `from` played `ratio` times as fast (counted from
 * the take as spoken), written to `file`, `duration` seconds long. Its words
 * and speech move with the audio; it remembers the take it came from, so a
 * second stretch starts from the spoken audio rather than compounding.
 */
export function stretchedTake(from: ClipTake, ratio: number, file: string, duration: number): ClipTake {
  const scale = (from.stretch ?? 1) / ratio;
  const at = (t: number) => Math.min(duration, t * scale);
  return {
    ...from,
    file,
    duration,
    stretch: ratio,
    original: from.original ?? from.file,
    ...(from.marks ? { marks: from.marks.map(([a, b]): [number, number] => [at(a), at(b)]) } : {}),
    ...(from.speech ? { speech: [at(from.speech[0]), at(from.speech[1])] } : {}),
  };
}

/** Where a stretched take is written: beside the take it was spoken as. */
export function stretchPath(original: string, ratio: number): string {
  return original.replace(/(\.[^.\\/]+)?$/, `-x${ratio.toFixed(3)}.wav`);
}

/**
 * Adds a take to a clip and plays it, keeping where the clip sits. A take of
 * the same file — the same stretch made again — replaces the old entry.
 */
export function addTake(voiceover: Voiceover, clipId: string, take: ClipTake): Voiceover {
  return {
    ...voiceover,
    clips: voiceover.clips.map((c) =>
      c.id === clipId
        ? {
            ...c,
            ...playTake(take),
            takes: [...(c.takes ?? []).filter((t) => t.file !== take.file), take],
          }
        : c,
    ),
  };
}

/**
 * The voice track a speaker's lines land on: theirs if it still exists.
 * Otherwise one no other speaker has, then a new one while there is room,
 * and only then the first, shared. A track found this way becomes the
 * speaker's, so their later lines follow it and two voices never share a
 * lane by accident.
 */
export function trackForVoice(
  voiceover: Voiceover,
  key: string,
): { voiceover: Voiceover; trackId: string } {
  const tracks = voiceTracks(voiceover);
  const wanted = voiceFor(voiceover, key).trackId;
  const own = tracks.find((t) => t.id === wanted);
  if (own) return { voiceover, trackId: own.id };

  const claimed = new Set(
    Object.entries(voiceover.cast)
      .filter(([other]) => other !== key)
      .map(([, voice]) => voice.trackId),
  );
  let next = voiceover;
  let trackId = tracks.find((t) => !claimed.has(t.id))?.id;
  if (!trackId && canAddTrack(voiceover)) {
    next = addTrack(voiceover);
    trackId = voiceTracks(next)[voiceTracks(next).length - 1].id;
  }
  // Every track taken and no room for another: the first is shared.
  trackId ??= tracks[0].id;
  return { voiceover: setVoice(next, key, { trackId }), trackId };
}

/**
 * What a clip plays of a take: the part where the voice is, so the silence a
 * model leaves around a line never pushes its first word late. A take with
 * no speech window plays whole.
 */
export function playTake(
  take: ClipTake,
): Pick<VoiceClip, "file" | "offset" | "duration" | "sourceDuration"> {
  const [from, to] = take.speech ?? [0, take.duration];
  const offset = Math.min(Math.max(0, from), take.duration);
  const end = Math.min(Math.max(offset, to), take.duration);
  return {
    file: take.file,
    offset,
    duration: end > offset ? end - offset : take.duration - offset,
    sourceDuration: take.duration,
  };
}

/**
 * Places a freshly generated take of a line. The clip already holding the
 * line's first cue gets the take — keeping where it was moved to, its track
 * and its gain — playing its speech; otherwise a new clip starts at the
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
  return placeTakes(voiceover, group, [take], 0, line);
}

/** `placeTake` for several takes of one line at once, playing `takes[best]`. */
export function placeTakes(
  voiceover: Voiceover,
  group: Cue[],
  takes: ClipTake[],
  best: number,
  line: RenderedLine = renderGroup(voiceover, group),
): Voiceover {
  const chosen = takes[best];
  if (!chosen) return voiceover;
  const ids = group.map((c) => c.id);
  const source = { cueIds: ids, text: line.text, voiceKey: renderedKey(line) };
  const existing = clipForCue(voiceover, ids[0]);
  const superseded = (c: VoiceClip) =>
    c !== existing && !!c.source && c.source.cueIds.every((id) => ids.includes(id));
  const clips = voiceover.clips.filter((c) => !superseded(c));

  if (existing) {
    const all = [...(existing.takes ?? []), ...takes];
    return {
      ...voiceover,
      clips: clips.map((c) =>
        c.id === existing.id ? { ...c, ...playTake(chosen), source, takes: all } : c,
      ),
    };
  }

  const placed = trackForVoice({ ...voiceover, clips }, castKey(group[0]));
  const clip: VoiceClip = {
    id: makeId(),
    trackId: placed.trackId,
    ...playTake(chosen),
    // Named after the subtitles, not the script: tags make poor labels.
    name: clipName(group.map(speechText).join(" ") || stripTags(source.text)),
    start: group[0].start,
    gainDb: 0,
    source,
    takes,
  };
  return { ...placed.voiceover, clips: [...placed.voiceover.clips, clip] };
}

/** How long a take's speech runs. */
export function speechLength(take: ClipTake): number {
  const [from, to] = take.speech ?? [0, take.duration];
  return to - from;
}

/**
 * The best of several takes of a line, by index: one that says its line over
 * one that may not, then the one whose speech best fills `window` seconds —
 * the time from the line's first cue to its last cue's end, where running
 * long is worse than running short — then the more surely aligned.
 */
export function rankTakes(takes: ClipTake[], window: number): number {
  const misfit = (t: ClipTake) => {
    const over = speechLength(t) - window;
    // A take that runs over pushes into the next line; one that is short
    // only leaves a pause.
    return over > 0 ? over * 2 : -over;
  };
  let best = 0;
  for (let i = 1; i < takes.length; i++) {
    const a = takes[i];
    const b = takes[best];
    const suspectA = isSuspect(a);
    const suspectB = isSuspect(b);
    if (suspectA !== suspectB) {
      if (!suspectA) best = i;
      continue;
    }
    const fit = misfit(a) - misfit(b);
    if (fit < -0.05 || (Math.abs(fit) <= 0.05 && (a.check?.score ?? 0) > (b.check?.score ?? 0))) {
      best = i;
    }
  }
  return best;
}

/** Switches a clip to another of its takes, playing its speech. */
export function selectTake(voiceover: Voiceover, clipId: string, index: number): Voiceover {
  return {
    ...voiceover,
    clips: voiceover.clips.map((c) => {
      const take = c.takes?.[index];
      if (c.id !== clipId || !take || c.file === take.file) return c;
      return { ...c, ...playTake(take) };
    }),
  };
}

/**
 * Where each cue's words fall in a take, when alignment did not say: shares
 * of `duration` seconds from `from`, in proportion to each cue's text. Rough,
 * but never empty.
 */
export function proportionalMarks(
  parts: string[],
  duration: number,
  from = 0,
): Array<[number, number]> {
  const weights = parts.map((p) => Math.max(1, stripTags(p).length));
  const total = weights.reduce((a, b) => a + b, 0);
  let at = from;
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
    const [speechFrom, speechTo] = take?.speech ?? [0, clip.sourceDuration];
    const marks =
      take?.marks?.length === cueIds.length
        ? take.marks
        : proportionalMarks(
            cueIds.map((id) => {
              const cue = cues.find((c) => c.id === id);
              return cue ? renderLine(voiceover, cue).text : "";
            }),
            speechTo - speechFrom,
            speechFrom,
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
 * next, else the previous); deleting the only take removes the
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
    next = { ...next, ...playTake(remaining[Math.min(index, remaining.length - 1)]) };
  }
  return { ...voiceover, clips: voiceover.clips.map((c) => (c.id === clipId ? next : c)) };
}

/**
 * The cues a reference is suggested from, before anyone has chosen: the
 * speaker's longest spoken lines, so a few good lines beat many fragments,
 * until there is enough. Thoughts are left out, since they are not the
 * character's audible voice, and so are lines another speaker's cue overlaps,
 * since their voice would be cloned too.
 */
export function suggestedReferenceCues(cues: Cue[], key: string): Cue[] {
  const others = cues.filter((c) => castKey(c) !== key);
  const candidates = cues
    .filter((c) => castKey(c) === key && c.mode !== "thought" && speechText(c) !== "")
    .filter((c) => !others.some((o) => o.start < c.end && o.end > c.start))
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

/** The folder a video's takes and references are written to, beside it. */
export function voiceoverDir(dir: string, stem: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${dir}${sep}${stem}.voiceover`;
}

/** Where a generated take is written: beside the video, one folder per video. */
export function takePath(dir: string, stem: string, cueId: string, seed: number): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${voiceoverDir(dir, stem)}${sep}${cueId.slice(0, 8)}-${seed}.wav`;
}

export function referencePath(dir: string, stem: string, key: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  const name = key === NO_SPEAKER ? "unassigned" : key.slice(0, 8);
  return `${voiceoverDir(dir, stem)}${sep}reference-${name}-${Date.now().toString(36)}.wav`;
}

/**
 * Every audio file the given versions of a voiceover use: what clips play,
 * every take kept on them and the takes those were stretched from, and every
 * voice's reference.
 */
export function voiceFilesInUse(voiceovers: Voiceover[]): string[] {
  const files = new Set<string>();
  for (const voiceover of voiceovers) {
    for (const clip of voiceover.clips) {
      files.add(clip.file);
      for (const take of clip.takes ?? []) {
        files.add(take.file);
        if (take.original) files.add(take.original);
      }
    }
    for (const voice of Object.values(voiceover.cast)) {
      if (voice.reference) files.add(voice.reference);
    }
  }
  return [...files];
}

function clipName(text: string): string {
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}
