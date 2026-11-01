/**
 * Re-cut safety: when an edit is baked again, everything timed against the old
 * video — cues, sections, timed beats, voice clips, gain points — moves with
 * the footage it was timed against.
 *
 * Each bake records what its video is made of, as segments: this stretch of
 * output is that stretch of that source. A moment of the old video is traced
 * back to its source and forward to wherever the new cut shows that source.
 * What the new cut no longer shows is not deleted: it is parked after the end
 * of the new video and flagged, for the writer to deal with.
 */

import type {
  CutSegment,
  Edit,
  GainPoint,
  Project,
  RecutKind,
  RecutRef,
  RecutReport,
} from "../types";
import { sourceOf, trackItems } from "./edit";
import { sortCues } from "./cues";
import { sortSections } from "./sections";
import { sortBeats } from "./timedBeats";

/** Closer than this is the same moment. */
const EPS = 1e-3;
/** Where parked items start, after the end of the new video. */
const PARK_AFTER = 1;
/** Parked items are closed up to at most this much apart. */
const PARK_GAP = 1;

/** What the edit's main track is made of: the video a bake of it shows. */
export function cutSegments(edit: Edit): CutSegment[] {
  const out: CutSegment[] = [];
  for (const track of edit.tracks) {
    if (track.kind !== "main" || track.hidden) continue;
    for (const item of trackItems(edit, track.id)) {
      if (item.kind === "video") {
        const source = sourceOf(edit, item);
        if (source) out.push({ start: item.start, duration: item.duration, source: source.path, offset: item.offset });
      } else if (item.kind === "image") {
        out.push({ start: item.start, duration: item.duration, source: `item:${item.id}`, offset: 0 });
      }
    }
  }
  return out;
}

/**
 * Before the first bake the project's video is a source itself, played
 * straight through: that is the old timeline. Null when it is not a source,
 * and there is nothing to trace from.
 */
export function originalSegments(edit: Edit, videoPath: string): CutSegment[] | null {
  const source = edit.sources.find((s) => s.kind === "video" && s.path === videoPath);
  if (!source || !(source.duration > 0)) return null;
  return [{ start: 0, duration: source.duration, source: source.path, offset: 0 }];
}

/** The old timeline to trace from: the last bake's, or the original video's. */
export function previousSegments(edit: Edit, videoPath: string): CutSegment[] | null {
  const baked = edit.baked;
  if (baked?.segments && baked.segments.length > 0 && baked.path === videoPath) return baked.segments;
  return originalSegments(edit, videoPath);
}

export type MapKind = "moved" | "cut" | "lost";

export interface Mapping {
  kind: MapKind;
  /** New time minus old time; 0 when lost. */
  delta: number;
}

const segEnd = (s: CutSegment) => s.start + s.duration;

/** Every new placement of the source under old output `[a, b]`: its shift and how much it keeps. */
function placements(
  oldSegs: CutSegment[],
  newSegs: CutSegment[],
  a: number,
  b: number,
): Array<{ delta: number; kept: number }> {
  const point = b - a < EPS;
  const out: Array<{ delta: number; kept: number }> = [];
  for (const o of oldSegs) {
    const lo = Math.max(a, o.start);
    const hi = Math.min(b, segEnd(o));
    // A point belongs to the segment it is in, the last one's end included.
    if (point ? a < o.start - 1e-9 || a > segEnd(o) + 1e-9 : hi - lo < 1e-9) continue;
    const s0 = o.offset + (lo - o.start);
    const s1 = o.offset + (hi - o.start);
    for (const n of newSegs) {
      if (n.source !== o.source) continue;
      const k0 = Math.max(s0, n.offset);
      const k1 = Math.min(s1, n.offset + n.duration);
      if (point ? s0 < n.offset - 1e-9 || s0 > n.offset + n.duration + 1e-9 : k1 - k0 < 1e-9) continue;
      out.push({ delta: n.start - n.offset - (o.start - o.offset), kept: point ? 0 : k1 - k0 });
    }
  }
  return out;
}

/** How much of `[a, b]` the old video showed footage for. */
function covered(oldSegs: CutSegment[], a: number, b: number): number {
  return oldSegs.reduce((sum, o) => sum + Math.max(0, Math.min(b, segEnd(o)) - Math.max(a, o.start)), 0);
}

/** The placement keeping the most, nearest its old time on a tie. */
function best(found: Array<{ delta: number; kept: number }>): { delta: number; kept: number } | null {
  const byDelta = new Map<number, { delta: number; kept: number }>();
  for (const f of found) {
    const key = Math.round(f.delta * 1e6) / 1e6;
    const entry = byDelta.get(key) ?? { delta: f.delta, kept: 0 };
    entry.kept += f.kept;
    byDelta.set(key, entry);
  }
  let pick: { delta: number; kept: number } | null = null;
  for (const c of byDelta.values()) {
    if (
      !pick ||
      c.kept > pick.kept + EPS ||
      (Math.abs(c.kept - pick.kept) <= EPS && Math.abs(c.delta) < Math.abs(pick.delta))
    ) {
      pick = c;
    }
  }
  return pick;
}

/**
 * Where the old stretch `[a, b]` goes (a point when `a === b`): moved whole,
 * cut through (moved with its larger kept part), or lost.
 *
 * Something over black — a gap, or only overlays — has no footage of its own;
 * it follows the footage just before it, or else just after.
 */
export function mapInterval(oldSegs: CutSegment[], newSegs: CutSegment[], a: number, b: number): Mapping {
  const footage = covered(oldSegs, a, b);
  if (b - a >= EPS && footage < EPS) return mapAnchored(oldSegs, newSegs, a);
  const pick = best(placements(oldSegs, newSegs, a, b));
  if (!pick) {
    if (b - a < EPS && !oldSegs.some((o) => a >= o.start - 1e-9 && a <= segEnd(o) + 1e-9)) {
      return mapAnchored(oldSegs, newSegs, a);
    }
    return { kind: "lost", delta: 0 };
  }
  if (b - a < EPS) return { kind: "moved", delta: pick.delta };
  return { kind: pick.kept >= footage - EPS ? "moved" : "cut", delta: pick.delta };
}

/** A moment over black follows the footage that ends before it, or starts after. */
function mapAnchored(oldSegs: CutSegment[], newSegs: CutSegment[], t: number): Mapping {
  const before = oldSegs.filter((o) => segEnd(o) <= t + 1e-9).sort((x, y) => segEnd(y) - segEnd(x))[0];
  if (before) {
    // Only where `before` itself went is an anchor.
    const own = best(placements([before], newSegs, segEnd(before), segEnd(before)));
    if (own) return { kind: "moved", delta: own.delta };
  }
  const after = oldSegs.filter((o) => o.start >= t - 1e-9).sort((x, y) => x.start - y.start)[0];
  if (after) {
    const own = best(placements([after], newSegs, after.start, after.start));
    if (own) return { kind: "moved", delta: own.delta };
  }
  return { kind: "lost", delta: 0 };
}

interface Timed {
  kind: RecutKind;
  id: string;
  a: number;
  b: number;
}

export interface RecutResult {
  project: Project;
  report: RecutReport;
}

/**
 * Moves everything timed in the project from the old cut to the new one.
 * Ids are kept, so what refers to a cue or clip by id still does.
 */
export function recutProject(
  project: Project,
  oldSegs: CutSegment[],
  newSegs: CutSegment[],
  newTotal: number,
): RecutResult {
  const timed: Timed[] = [
    ...project.cues.map((c) => ({ kind: "cue" as const, id: c.id, a: c.start, b: c.end })),
    ...project.voiceover.clips.map((c) => ({ kind: "clip" as const, id: c.id, a: c.start, b: c.start + c.duration })),
    ...project.sections.map((s) => ({ kind: "section" as const, id: s.id, a: s.start, b: s.start })),
    ...project.timedBeats.map((t) => ({ kind: "beat" as const, id: t.id, a: t.time, b: t.time })),
  ];

  const starts = new Map<string, number>();
  const key = (t: { kind: RecutKind; id: string }) => `${t.kind}:${t.id}`;
  const cut: RecutRef[] = [];
  const lost: Timed[] = [];
  let moved = 0;

  for (const t of timed) {
    const m = mapInterval(oldSegs, newSegs, t.a, t.b);
    if (m.kind === "lost") {
      lost.push(t);
      continue;
    }
    // Never before zero; a cue keeps its length.
    const start = Math.max(0, t.a + m.delta);
    starts.set(key(t), start);
    if (m.kind === "cut") cut.push({ kind: t.kind, id: t.id, at: start });
    else moved++;
  }

  // Park the lost after the end, in their old order, closing long gaps up.
  const parked: RecutRef[] = [];
  lost.sort((x, y) => x.a - y.a);
  let offset = 0;
  let lastEnd = -Infinity;
  lost.forEach((t, i) => {
    if (i === 0) offset = newTotal + PARK_AFTER - t.a;
    else if (t.a - lastEnd > PARK_GAP) offset -= t.a - lastEnd - PARK_GAP;
    lastEnd = Math.max(lastEnd, t.b);
    const start = t.a + offset;
    starts.set(key(t), start);
    parked.push({ kind: t.kind, id: t.id, at: start });
  });

  const startOf = (kind: RecutKind, id: string, fallback: number) => starts.get(`${kind}:${id}`) ?? fallback;

  // Gain points follow their sound; a point in removed footage has no sound
  // left to shape, and goes.
  let droppedPoints = 0;
  const movePoints = (points: GainPoint[]): GainPoint[] =>
    points
      .flatMap((p) => {
        const m = mapInterval(oldSegs, newSegs, p.time, p.time);
        if (m.kind === "lost") {
          droppedPoints++;
          return [];
        }
        return [{ ...p, time: Math.max(0, p.time + m.delta) }];
      })
      .sort((x, y) => x.time - y.time);

  const next: Project = {
    ...project,
    cues: sortCues(
      project.cues.map((c) => {
        const start = startOf("cue", c.id, c.start);
        return start === c.start ? c : { ...c, start, end: start + (c.end - c.start) };
      }),
    ),
    sections: sortSections(
      project.sections.map((s) => {
        const start = startOf("section", s.id, s.start);
        return start === s.start ? s : { ...s, start };
      }),
    ),
    timedBeats: sortBeats(
      project.timedBeats.map((t) => {
        const time = startOf("beat", t.id, t.time);
        return time === t.time ? t : { ...t, time };
      }),
    ),
    voiceover: {
      ...project.voiceover,
      tracks: project.voiceover.tracks.map((tr) =>
        tr.automation.length === 0 ? tr : { ...tr, automation: movePoints(tr.automation) },
      ),
      clips: project.voiceover.clips.map((c) => {
        const start = startOf("clip", c.id, c.start);
        return start === c.start ? c : { ...c, start };
      }),
    },
  };

  return {
    project: next,
    report: { at: new Date().toISOString(), moved, cut, lost: parked, droppedPoints },
  };
}

/** True when a report has anything to show. */
export function hasFlags(report: RecutReport | undefined): report is RecutReport {
  return Boolean(report && (report.cut.length > 0 || report.lost.length > 0));
}

/**
 * The flag on one item, if it still applies: a flag lapses once the item is
 * moved from where the re-cut put it, since the writer has dealt with it.
 */
export function recutFlag(
  report: RecutReport | undefined,
  kind: RecutKind,
  id: string,
  start: number,
): "lost" | "cut" | undefined {
  if (!report) return undefined;
  const same = (r: RecutRef) => r.kind === kind && r.id === id && Math.abs(r.at - start) < EPS;
  if (report.lost.some(same)) return "lost";
  if (report.cut.some(same)) return "cut";
  return undefined;
}

/** A one-line account of a re-cut, for a notice or the bake dialog. */
export function describeRecut(report: RecutReport, verb: "moved" | "move" = "moved"): string {
  const parts = [`${report.moved} ${verb} with the cut`];
  if (report.cut.length > 0) parts.push(`${report.cut.length} cut through`);
  if (report.lost.length > 0) parts.push(`${report.lost.length} in removed footage, parked after the end`);
  if (report.droppedPoints > 0) parts.push(`${report.droppedPoints} gain point${report.droppedPoints === 1 ? "" : "s"} dropped`);
  return parts.join("; ");
}
