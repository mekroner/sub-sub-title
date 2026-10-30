/**
 * Pure operations on timed story beats — what happens, or should happen, at a
 * moment. Kept free of React so they stay testable, like `sections.ts`.
 *
 * Beats are stored flat, in time order, and grouped by section span only for
 * display: a flag can move, appear or vanish without a beat going with it.
 *
 * Functions return the array they were given when nothing changed, which is
 * what `setTimedBeats` in App.tsx tests to skip an undo entry.
 */

import type { Section, TimedBeat } from "../types";
import { makeId } from "./ids";
import { sectionSpans, sortSections } from "./sections";
import { formatShort } from "./time";

export function sortBeats(beats: TimedBeat[]): TimedBeat[] {
  return [...beats].sort((a, b) => a.time - b.time);
}

export function newBeat(time: number, text = "", by?: "agent"): TimedBeat {
  return { id: makeId(), time: Math.max(0, time), text, ...(by ? { by } : {}) };
}

export function addBeat(beats: TimedBeat[], beat: TimedBeat): TimedBeat[] {
  return sortBeats([...beats, beat]);
}

/**
 * Changes a beat's time or text. An edit by the writer (`by` omitted) makes an
 * agent's beat theirs, so the next story run treats it as a fixed point.
 */
export function editBeat(
  beats: TimedBeat[],
  id: string,
  patch: { time?: number; text?: string },
  by?: "agent",
): TimedBeat[] {
  const current = beats.find((b) => b.id === id);
  if (!current) return beats;
  const time = patch.time === undefined ? current.time : Math.max(0, patch.time);
  const text = patch.text ?? current.text;
  const owner = by ?? undefined;
  if (time === current.time && text === current.text && owner === current.by) return beats;
  const { by: _by, ...rest } = current;
  const next: TimedBeat = { ...rest, time, text, ...(owner ? { by: owner } : {}) };
  return sortBeats(beats.map((b) => (b.id === id ? next : b)));
}

export function removeBeat(beats: TimedBeat[], id: string): TimedBeat[] {
  const next = beats.filter((b) => b.id !== id);
  return next.length === beats.length ? beats : next;
}

/** Beats at `from` or later and before `to`, in time order. */
export function beatsBetween(beats: TimedBeat[], from: number, to: number): TimedBeat[] {
  return sortBeats(beats).filter((b) => b.time >= from && b.time < to);
}

/** Beats as a prompt reads them: `- [1:32.00] Ben finally admits it`. */
export function renderTimedBeats(beats: TimedBeat[]): string {
  return sortBeats(beats)
    .filter((b) => b.text.trim())
    .map((b) => `- [${formatShort(b.time)}] ${b.text.replace(/\s+/g, " ").trim()}`)
    .join("\n");
}

export interface BeatGroup {
  /** Null for the stretch before the first section. */
  section: Section | null;
  start: number;
  end: number;
  beats: TimedBeat[];
}

/**
 * Beats grouped by the section span they fall in, one group per section. The
 * stretch before the first section gets a group of its own only when it holds
 * beats — or when there are no sections at all.
 */
export function groupBySection(sections: Section[], beats: TimedBeat[], duration: number): BeatGroup[] {
  const sorted = sortBeats(beats);
  const spans = sectionSpans(sortSections(sections), duration);
  const firstStart = spans.length > 0 ? spans[0].start : Infinity;
  const groups: BeatGroup[] = spans.map((span, i) => ({
    section: span,
    start: span.start,
    // The last span also takes beats a too-short duration would leave out.
    end: i === spans.length - 1 ? Infinity : span.end,
    beats: [],
  }));
  const before: TimedBeat[] = [];
  for (const beat of sorted) {
    if (beat.time < firstStart) {
      before.push(beat);
      continue;
    }
    const group = groups.find((g) => beat.time >= g.start && beat.time < g.end);
    group?.beats.push(beat);
  }
  const out = groups.map((g) => ({ ...g, end: g.end === Infinity ? Math.max(duration, g.start) : g.end }));
  if (before.length > 0 || spans.length === 0) {
    out.unshift({ section: null, start: 0, end: Math.min(firstStart, duration || firstStart), beats: before });
  }
  return out;
}
