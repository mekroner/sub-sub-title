/** Pure operations on the cue list. Kept free of React so they stay testable. */

import type { Cue } from "../types";
import { makeId } from "./ids";
import { clamp } from "./time";

export const MIN_CUE_DURATION = 0.08;

export function sortCues(cues: Cue[]): Cue[] {
  return [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Index of the cue covering `time`, or -1. Cues are start-sorted, so this is a
 * binary search plus a short walk back over any overlapping cues.
 */
export function findActiveCueIndex(cues: Cue[], time: number): number {
  if (cues.length === 0) return -1;

  let lo = 0;
  let hi = cues.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= time) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  for (let i = candidate; i >= 0 && i > candidate - 12; i -= 1) {
    if (cues[i].start <= time && time < cues[i].end) return i;
  }
  return -1;
}

/** The cue to select when scrubbing: the active one, else the next upcoming. */
export function findNearestCueIndex(cues: Cue[], time: number): number {
  const active = findActiveCueIndex(cues, time);
  if (active !== -1) return active;
  const next = cues.findIndex((c) => c.start >= time);
  if (next !== -1) return next;
  return cues.length - 1;
}

/**
 * Split the text at the point matching where in the cue the playhead sits.
 * Prefers an existing line break, then the nearest word boundary.
 */
function splitText(text: string, ratio: number): [string, string] {
  const newline = text.indexOf("\n");
  if (newline !== -1) {
    return [text.slice(0, newline).trim(), text.slice(newline + 1).trim()];
  }

  const target = Math.round(text.length * clamp(ratio, 0, 1));
  let best = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== " ") continue;
    if (best === -1 || Math.abs(i - target) < Math.abs(best - target)) best = i;
  }
  if (best === -1) return [text.trim(), ""];
  return [text.slice(0, best).trim(), text.slice(best + 1).trim()];
}

export interface SplitResult {
  cues: Cue[];
  /** The cue to select afterwards: the second half. */
  newCueId: string | null;
}

export function splitCueAt(cues: Cue[], cueId: string, time: number): SplitResult {
  const index = cues.findIndex((c) => c.id === cueId);
  if (index === -1) return { cues, newCueId: null };

  const cue = cues[index];
  // Refuse a split that would leave either half below the minimum duration.
  if (
    time <= cue.start + MIN_CUE_DURATION ||
    time >= cue.end - MIN_CUE_DURATION
  ) {
    return { cues, newCueId: null };
  }

  const ratio = (time - cue.start) / (cue.end - cue.start);
  const [head, tail] = splitText(cue.text, ratio);

  const first: Cue = { ...cue, end: time, text: head };
  const second: Cue = {
    ...cue,
    id: makeId(),
    start: time,
    end: cue.end,
    text: tail,
  };

  const next = [...cues];
  next.splice(index, 1, first, second);
  return { cues: next, newCueId: second.id };
}

export function mergeWithNext(cues: Cue[], cueId: string): Cue[] {
  const index = cues.findIndex((c) => c.id === cueId);
  if (index === -1 || index === cues.length - 1) return cues;

  const a = cues[index];
  const b = cues[index + 1];
  const merged: Cue = {
    ...a,
    end: Math.max(a.end, b.end),
    text: [a.text, b.text].map((t) => t.trim()).filter(Boolean).join("\n"),
    // The first cue's speaker wins; the second is usually the continuation.
    speakerId: a.speakerId ?? b.speakerId,
  };

  const next = [...cues];
  next.splice(index, 2, merged);
  return next;
}

/** Apply a delta to a cue edge, keeping start < end and both within the media. */
export function nudgeCue(
  cues: Cue[],
  cueId: string,
  edge: "start" | "end" | "both",
  delta: number,
  duration: number,
): Cue[] {
  return cues.map((cue) => {
    if (cue.id !== cueId) return cue;
    const limit = duration > 0 ? duration : Number.MAX_SAFE_INTEGER;

    if (edge === "both") {
      const width = cue.end - cue.start;
      const start = clamp(cue.start + delta, 0, Math.max(0, limit - width));
      return { ...cue, start, end: start + width };
    }
    if (edge === "start") {
      return { ...cue, start: clamp(cue.start + delta, 0, cue.end - MIN_CUE_DURATION) };
    }
    return { ...cue, end: clamp(cue.end + delta, cue.start + MIN_CUE_DURATION, limit) };
  });
}

export function setCueTiming(
  cues: Cue[],
  cueId: string,
  start: number,
  end: number,
  duration: number,
): Cue[] {
  const limit = duration > 0 ? duration : Number.MAX_SAFE_INTEGER;
  return cues.map((cue) =>
    cue.id === cueId
      ? {
          ...cue,
          start: clamp(start, 0, limit),
          end: clamp(Math.max(end, start + MIN_CUE_DURATION), 0, limit),
        }
      : cue,
  );
}

/**
 * Find a free slot for a newly generated line: after the given cue, in the gap
 * before the next one, defaulting to two seconds.
 */
export function slotAfter(cues: Cue[], afterId: string | null, duration: number): {
  start: number;
  end: number;
} {
  const sorted = sortCues(cues);
  const index = afterId ? sorted.findIndex((c) => c.id === afterId) : sorted.length - 1;
  const previous = index >= 0 ? sorted[index] : undefined;
  const following = index >= 0 ? sorted[index + 1] : undefined;

  const start = previous ? previous.end + 0.05 : 0;
  const limit = duration > 0 ? duration : start + 2;
  const gapEnd = following ? following.start - 0.05 : limit;
  const end = Math.min(start + 2, Math.max(start + MIN_CUE_DURATION, gapEnd));

  return { start: Math.min(start, limit), end: Math.min(end, limit) };
}

export function insertCue(cues: Cue[], cue: Cue): Cue[] {
  return sortCues([...cues, cue]);
}

export function newCue(start: number, end: number, speakerId: string | null = null): Cue {
  return { id: makeId(), start, end, text: "", speakerId };
}

// --- Overlap-free timing --------------------------------------------------
// A cue may never overlap its neighbours. Resizes clamp against them; a whole
// cue drag, by contrast, may travel across a neighbour and change the order,
// which is decided by where the dragged cue's midpoint lands.

/** Default breathing space between adjacent cues, in seconds. */
export const DEFAULT_MIN_GAP = 0.04;

const EPSILON = 0.0005;

function unchanged(cue: Cue, start: number, end: number): boolean {
  return Math.abs(cue.start - start) < EPSILON && Math.abs(cue.end - end) < EPSILON;
}

/**
 * The free intervals left by `others` (start-sorted and non-overlapping), with
 * `minGap` shaved off each side.
 */
function freeGaps(others: Cue[], limit: number, minGap: number): Array<[number, number]> {
  const gaps: Array<[number, number]> = [];
  let cursor = 0;
  for (const other of others) {
    gaps.push([cursor, other.start - minGap]);
    cursor = Math.max(cursor, other.end + minGap);
  }
  gaps.push([cursor, limit]);
  return gaps;
}

/**
 * Move one edge (or both, when the caller passes an explicit window), clamped
 * so the cue stays inside the space its neighbours leave it.
 */
export function resizeCue(
  cues: Cue[],
  cueId: string,
  start: number,
  end: number,
  duration: number,
  minGap = DEFAULT_MIN_GAP,
): Cue[] {
  const sorted = sortCues(cues);
  const index = sorted.findIndex((c) => c.id === cueId);
  if (index === -1) return cues;

  const cue = sorted[index];
  const limit = duration > 0 ? duration : Number.MAX_SAFE_INTEGER;
  const lower = index > 0 ? sorted[index - 1].end + minGap : 0;
  const upper = index < sorted.length - 1 ? sorted[index + 1].start - minGap : limit;

  // Neighbours can leave less room than a cue is allowed to occupy (a tight
  // import, say); refuse rather than produce something illegal.
  if (upper - lower < MIN_CUE_DURATION) return cues;

  const nextStart = clamp(start, lower, upper - MIN_CUE_DURATION);
  const nextEnd = clamp(end, nextStart + MIN_CUE_DURATION, upper);
  if (unchanged(cue, nextStart, nextEnd)) return cues;

  return sorted.map((c) =>
    c.id === cueId ? { ...c, start: nextStart, end: nextEnd } : c,
  );
}

/**
 * Move a whole cue, keeping its duration. The cue lands in whichever free gap
 * its midpoint falls into, so dragging past a neighbour's middle carries it
 * across and reorders the two. A gap too small to hold the cue is refused, and
 * the cue stays where it was.
 */
export function moveCueTo(
  cues: Cue[],
  cueId: string,
  start: number,
  duration: number,
  minGap = DEFAULT_MIN_GAP,
): Cue[] {
  const cue = cues.find((c) => c.id === cueId);
  if (!cue) return cues;

  const width = cue.end - cue.start;
  const limit = duration > 0 ? duration : Number.MAX_SAFE_INTEGER;
  const others = sortCues(cues.filter((c) => c.id !== cueId));

  const desired = clamp(start, 0, Math.max(0, limit - width));
  const midpoint = desired + width / 2;

  // The gap holding the midpoint; when the midpoint is over another cue, the
  // nearer gap wins, which is what makes a drag flip sides at the halfway mark.
  const gaps = freeGaps(others, limit, minGap).filter(([lo, hi]) => hi - lo >= width);
  if (gaps.length === 0) return cues;

  const distance = ([lo, hi]: [number, number]) =>
    midpoint < lo ? lo - midpoint : midpoint > hi ? midpoint - hi : 0;
  const target = gaps.reduce((best, gap) => (distance(gap) < distance(best) ? gap : best));

  const nextStart = clamp(desired, target[0], target[1] - width);
  if (unchanged(cue, nextStart, nextStart + width)) return cues;

  return sortCues(
    cues.map((c) =>
      c.id === cueId ? { ...c, start: nextStart, end: nextStart + width } : c,
    ),
  );
}

/**
 * Shift a whole selection in time, keeping the cues' spacing. The selection
 * moves as one block and is clamped against the cues that are not selected; a
 * block never jumps over anything, unlike a single-cue drag.
 */
export function moveCuesBy(
  cues: Cue[],
  ids: Iterable<string>,
  delta: number,
  duration: number,
  minGap = DEFAULT_MIN_GAP,
): Cue[] {
  const set = new Set(ids);
  const selected = cues.filter((c) => set.has(c.id));
  if (selected.length === 0 || delta === 0) return cues;

  const blockStart = Math.min(...selected.map((c) => c.start));
  const blockEnd = Math.max(...selected.map((c) => c.end));
  const width = blockEnd - blockStart;
  const limit = duration > 0 ? duration : Number.MAX_SAFE_INTEGER;
  const others = sortCues(cues.filter((c) => !set.has(c.id)));

  const desired = clamp(blockStart + delta, 0, Math.max(0, limit - width));
  const home = freeGaps(others, limit, minGap).find(
    ([lo, hi]) =>
      hi - lo >= width && lo <= blockStart + EPSILON && hi >= blockEnd - EPSILON,
  );
  if (!home) return cues;

  const actual = clamp(desired, home[0], home[1] - width) - blockStart;
  if (Math.abs(actual) < EPSILON) return cues;

  return sortCues(
    cues.map((c) =>
      set.has(c.id) ? { ...c, start: c.start + actual, end: c.end + actual } : c,
    ),
  );
}

/**
 * Insert a new cue, trimmed to the room its neighbours leave. Returns null when
 * there is no room at all, so the caller can say so instead of creating a cue
 * that overlaps.
 */
export function insertCueClamped(
  cues: Cue[],
  cue: Cue,
  duration: number,
  minGap = DEFAULT_MIN_GAP,
): Cue[] | null {
  const inserted = insertCue(cues, cue);
  const clamped = resizeCue(inserted, cue.id, cue.start, cue.end, duration, minGap);
  // Any overlaps the list already had are none of this function's business;
  // introducing a new one means there was no room.
  const before = findOverlaps(cues, minGap).length;
  return findOverlaps(clamped, minGap).length > before ? null : clamped;
}

/** Cues that start before their predecessor has finished. */
export function findOverlaps(cues: Cue[], minGap = 0): Cue[] {
  const sorted = sortCues(cues);
  const bad: Cue[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].start < sorted[i - 1].end + minGap - EPSILON) bad.push(sorted[i]);
  }
  return bad;
}

/**
 * Pull overlapping cues apart, for material that arrives overlapped (an .srt
 * from another tool). The earlier cue is trimmed where that leaves it long
 * enough to read; otherwise the later cue is pushed back.
 */
export function resolveOverlaps(cues: Cue[], minGap = DEFAULT_MIN_GAP): Cue[] {
  const out = sortCues(cues);
  let changed = false;

  for (let i = 1; i < out.length; i += 1) {
    const prev = out[i - 1];
    const cur = out[i];
    if (cur.start >= prev.end + minGap - EPSILON) continue;

    const trimmed = cur.start - minGap;
    if (trimmed - prev.start >= MIN_CUE_DURATION) {
      out[i - 1] = { ...prev, end: trimmed };
    } else {
      const start = prev.end + minGap;
      out[i] = { ...cur, start, end: Math.max(cur.end, start + MIN_CUE_DURATION) };
    }
    changed = true;
  }

  return changed ? sortCues(out) : cues;
}

// --- Join and duplicate ---------------------------------------------------

/**
 * Merge a contiguous run of cues into one. Returns null when the selection is
 * not contiguous, since joining across a cue that stays behind would reorder
 * the dialogue silently.
 */
export function joinCues(cues: Cue[], ids: Iterable<string>): Cue[] | null {
  const set = new Set(ids);
  const sorted = sortCues(cues);
  const indices = sorted.map((c, i) => (set.has(c.id) ? i : -1)).filter((i) => i !== -1);

  if (indices.length < 2) return null;
  const first = indices[0];
  const last = indices[indices.length - 1];
  if (last - first + 1 !== indices.length) return null;

  const run = sorted.slice(first, last + 1);
  const merged: Cue = {
    ...run[0],
    start: Math.min(...run.map((c) => c.start)),
    end: Math.max(...run.map((c) => c.end)),
    text: run.map((c) => c.text.trim()).filter(Boolean).join("\n"),
    speakerId: run.find((c) => c.speakerId)?.speakerId ?? null,
  };

  const next = [...sorted];
  next.splice(first, run.length, merged);
  return next;
}

export interface DuplicateResult {
  cues: Cue[];
  /** The copy, to select afterwards; null when there was no room for it. */
  newCueId: string | null;
}

/** Copy a cue into the free space after it, keeping its text and speaker. */
export function duplicateCue(
  cues: Cue[],
  cueId: string,
  duration: number,
  minGap = DEFAULT_MIN_GAP,
): DuplicateResult {
  const cue = cues.find((c) => c.id === cueId);
  if (!cue) return { cues, newCueId: null };

  const width = cue.end - cue.start;
  const limit = duration > 0 ? duration : cue.end + width + 1;
  const following = sortCues(cues.filter((c) => c.id !== cue.id)).find(
    (c) => c.start >= cue.end,
  );

  const start = cue.end + minGap;
  const roomEnd = following ? following.start - minGap : limit;
  const end = Math.min(start + width, roomEnd);
  if (end - start < MIN_CUE_DURATION) return { cues, newCueId: null };

  const copy: Cue = { ...cue, id: makeId(), start, end };
  return { cues: insertCue(cues, copy), newCueId: copy.id };
}
