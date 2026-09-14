/**
 * Pure operations on the section list — the named flags on the timeline. Kept
 * free of React so they stay testable, like `cues.ts`.
 *
 * A section is a single instant. The span it covers runs to the next section's
 * start, and is derived here rather than stored, so two neighbours can never
 * disagree about where one ends and the next begins.
 *
 * Functions return the array they were given when nothing changed, which is
 * what `setSections` in App.tsx tests to skip an undo entry.
 */

import type { Section } from "../types";
import { makeId } from "./ids";
import { clamp } from "./time";

/**
 * Slack when comparing an instant against a section's start. Small enough that
 * two deliberate flags a frame apart stay distinct, large enough that a jump
 * does not stick on the section the playhead is already sitting exactly on.
 */
const EPSILON = 0.001;

export function sortSections(sections: Section[]): Section[] {
  return [...sections].sort((a, b) => a.start - b.start);
}

/**
 * A flag for `insertSection`, named after the count rather than its position so
 * the name does not change meaning when an earlier flag is added later.
 */
export function newSection(sections: Section[], start: number): Section {
  return { id: makeId(), start, label: `Section ${sections.length + 1}` };
}

export function insertSection(
  sections: Section[],
  section: Section,
  duration: number,
): Section[] {
  return sortSections([...sections, { ...section, start: clamp(section.start, 0, duration) }]);
}

export function renameSection(sections: Section[], id: string, label: string): Section[] {
  const current = sections.find((s) => s.id === id);
  if (!current || current.label === label) return sections;
  return sections.map((s) => (s.id === id ? { ...s, label } : s));
}

/** A blank note is removed rather than stored, so the project file stays lean. */
export function setSectionNote(sections: Section[], id: string, note: string): Section[] {
  const current = sections.find((s) => s.id === id);
  if (!current || (current.note ?? "") === note) return sections;
  return sections.map((s) => {
    if (s.id !== id) return s;
    if (note.trim() === "") {
      const { note: _note, ...rest } = s;
      return rest;
    }
    return { ...s, note };
  });
}

export function moveSection(
  sections: Section[],
  id: string,
  start: number,
  duration: number,
): Section[] {
  const current = sections.find((s) => s.id === id);
  if (!current) return sections;
  const next = clamp(start, 0, duration);
  if (next === current.start) return sections;
  return sortSections(sections.map((s) => (s.id === id ? { ...s, start: next } : s)));
}

export function removeSection(sections: Section[], id: string): Section[] {
  const next = sections.filter((s) => s.id !== id);
  return next.length === sections.length ? sections : next;
}

export interface SectionSpan extends Section {
  /** The next section's start, or the end of the video for the last one. */
  end: number;
}

/**
 * Every section with the span it covers. The single place the span-to-next rule
 * is decided, so the timeline lane and the side panel cannot drift apart.
 *
 * Sorts defensively rather than trusting the caller: a stale render mid-drag
 * would otherwise produce a span running backwards.
 */
export function sectionSpans(sections: Section[], duration: number): SectionSpan[] {
  const sorted = sortSections(sections);
  return sorted.map((section, index) => ({
    ...section,
    end: index + 1 < sorted.length ? sorted[index + 1].start : duration,
  }));
}

/** The section covering `time`, or null when the first one starts later. */
export function sectionAt(sections: Section[], time: number): Section | null {
  let found: Section | null = null;
  for (const section of sortSections(sections)) {
    if (section.start > time + EPSILON) break;
    found = section;
  }
  return found;
}

/** The first section starting after `time`, for jumping forward. */
export function nextSection(sections: Section[], time: number): Section | null {
  for (const section of sortSections(sections)) {
    if (section.start > time + EPSILON) return section;
  }
  return null;
}

/**
 * The last section starting before `time`. The epsilon is what makes repeated
 * presses walk backwards instead of re-selecting the flag the playhead just
 * landed on.
 */
export function previousSection(sections: Section[], time: number): Section | null {
  let found: Section | null = null;
  for (const section of sortSections(sections)) {
    if (section.start >= time - EPSILON) break;
    found = section;
  }
  return found;
}
