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
