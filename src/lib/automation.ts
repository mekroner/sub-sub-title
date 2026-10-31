/**
 * Gain curves: points in dB joined by a monotone cubic (PCHIP, Fritsch–Carlson).
 *
 * Monotone because a free cubic spline overshoots: between a point at 0 dB and
 * one at −20 dB it would swing above 0, which is a loudness bump nobody drew.
 * PCHIP never leaves the range of its neighbouring points, and its slope is
 * zero at every plateau and turning point, so a duck eases in and out.
 *
 * Interpolating in dB rather than in linear gain is what makes a fade sound
 * even: the ear hears ratios, and a linear ramp spends most of its length
 * near the top.
 *
 * Mirrored by the export mixer in Rust; both are checked against
 * `automation.fixtures.json`, so preview and render cannot drift apart.
 */

import type { Cue, DuckSettings, GainPoint, Voiceover } from "../types";
import { MAX_DB, MIN_DB, clampDb } from "./voiceover";

/** Two points closer than this in time would make a vertical step. */
export const MIN_POINT_GAP = 0.01;

interface Prepared {
  xs: number[];
  ys: number[];
  /** Slope at each point, dB per second. */
  ms: number[];
}

/** Curves are immutable project data, so the slopes are cached per array. */
const prepared = new WeakMap<GainPoint[], Prepared>();

function prepare(points: GainPoint[]): Prepared {
  const cached = prepared.get(points);
  if (cached) return cached;

  const xs = points.map((p) => p.time);
  const ys = points.map((p) => p.db);
  const n = xs.length;
  const ms = new Array<number>(n).fill(0);
  const h: number[] = [];
  const delta: number[] = [];
  for (let k = 0; k < n - 1; k++) {
    h.push(xs[k + 1] - xs[k]);
    delta.push(h[k] > 0 ? (ys[k + 1] - ys[k]) / h[k] : 0);
  }
  // Interior slopes: zero at a turning point or plateau, otherwise the
  // weighted harmonic mean of the neighbouring secants. The two ends keep a
  // zero slope, because the curve holds flat beyond them.
  for (let k = 1; k < n - 1; k++) {
    if (delta[k - 1] * delta[k] <= 0) continue;
    const w1 = 2 * h[k] + h[k - 1];
    const w2 = h[k] + 2 * h[k - 1];
    ms[k] = (w1 + w2) / (w1 / delta[k - 1] + w2 / delta[k]);
  }

  const result = { xs, ys, ms };
  prepared.set(points, result);
  return result;
}

/**
 * The curve's value at `time`, in dB. No points means 0 dB; before the first
 * point and after the last the curve holds that point's value.
 */
export function curveDb(points: GainPoint[], time: number): number {
  const n = points.length;
  if (n === 0) return 0;
  if (time <= points[0].time) return points[0].db;
  if (time >= points[n - 1].time) return points[n - 1].db;

  const { xs, ys, ms } = prepare(points);
  // The last point at or before `time`.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= time) lo = mid;
    else hi = mid;
  }
  const h = xs[hi] - xs[lo];
  if (h <= 0) return ys[hi];
  const t = (time - xs[lo]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * ys[lo] +
    (t3 - 2 * t2 + t) * h * ms[lo] +
    (-2 * t3 + 3 * t2) * ys[hi] +
    (t3 - t2) * h * ms[hi]
  );
}

function clampPoint(point: GainPoint): GainPoint {
  return { time: Math.max(0, point.time), db: clampDb(point.db) };
}

/** Inserts a point in time order; returns the new curve and the point's index. */
export function addPoint(
  points: GainPoint[],
  point: GainPoint,
): { points: GainPoint[]; index: number } {
  const p = clampPoint(point);
  let index = points.findIndex((q) => q.time > p.time);
  if (index < 0) index = points.length;
  // A point dropped onto an existing one replaces it rather than stacking.
  const before = points[index - 1];
  if (before && p.time - before.time < MIN_POINT_GAP) {
    const next = points.slice();
    next[index - 1] = { time: before.time, db: p.db };
    return { points: next, index: index - 1 };
  }
  const after = points[index];
  if (after && after.time - p.time < MIN_POINT_GAP) {
    const next = points.slice();
    next[index] = { time: after.time, db: p.db };
    return { points: next, index };
  }
  return { points: [...points.slice(0, index), p, ...points.slice(index)], index };
}

/**
 * Moves one point, held between its neighbours so the curve's order never
 * changes under a drag (which would also change the dragged point's index).
 */
export function movePoint(points: GainPoint[], index: number, point: GainPoint): GainPoint[] {
  if (index < 0 || index >= points.length) return points;
  const lower = index > 0 ? points[index - 1].time + MIN_POINT_GAP : 0;
  const upper = index < points.length - 1 ? points[index + 1].time - MIN_POINT_GAP : Infinity;
  const time = Math.min(upper, Math.max(lower, point.time));
  const db = clampDb(point.db);
  const current = points[index];
  if (current.time === time && current.db === db) return points;
  const next = points.slice();
  next[index] = { time, db };
  return next;
}

export function removePoint(points: GainPoint[], index: number): GainPoint[] {
  if (index < 0 || index >= points.length) return points;
  return [...points.slice(0, index), ...points.slice(index + 1)];
}

/**
 * The shape of a duck. `bridge` merges regions closer than that (after their
 * fades), so the bed does not bob back up for a breath between two lines.
 */
export type DuckOptions = Pick<DuckSettings, "depthDb" | "attack" | "release" | "bridge">;

/**
 * The original track's automatic duck: a dip under every cue that has not
 * been switched off. Derived on demand rather than stored, so moving, adding
 * or deleting a cue reshapes the duck with no further step.
 */
export function cueDuckCurve(voiceover: Voiceover, cues: Cue[]): GainPoint[] {
  if (!voiceover.duck.enabled || voiceover.duck.depthDb >= 0) return [];
  const off = new Set(voiceover.unduckedCueIds);
  return duckCurve(
    cues.filter((cue) => !off.has(cue.id)),
    voiceover.duck,
  );
}

/**
 * A curve that sits at 0 dB and dips to `depthDb` across every region. The
 * fades sit outside the regions, so the bed is fully down when the line starts
 * and only rises once it has ended. Regions may arrive in any order.
 */
export function duckCurve(
  regions: Array<{ start: number; end: number }>,
  options: DuckOptions,
): GainPoint[] {
  const depth = Math.min(0, Math.max(MIN_DB, options.depthDb));
  const attack = Math.max(MIN_POINT_GAP, options.attack);
  const release = Math.max(MIN_POINT_GAP, options.release);
  const bridge = Math.max(0, options.bridge);

  const sorted = regions
    .filter((r) => r.end > r.start)
    .map((r) => ({ start: Math.max(0, r.start), end: r.end }))
    .sort((a, b) => a.start - b.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const region of sorted) {
    const last = merged[merged.length - 1];
    // `<=` so that touching fades merge rather than share an instant.
    if (last && region.start - attack - (last.end + release) <= bridge) {
      last.end = Math.max(last.end, region.end);
    } else {
      merged.push({ ...region });
    }
  }

  const points: GainPoint[] = [];
  for (const { start, end } of merged) {
    const fadeFrom = start - attack;
    if (fadeFrom > 0) points.push({ time: fadeFrom, db: 0 });
    // A region too close to zero for its fade begins already ducked.
    points.push({ time: fadeFrom > 0 ? start : 0, db: depth });
    points.push({ time: Math.max(end, start + MIN_POINT_GAP), db: depth });
    points.push({ time: end + release, db: 0 });
  }
  return points;
}

/** For drawing: the curve's dB as a 0 (top) .. 1 (bottom) position. */
export function dbToY(db: number): number {
  return 1 - (clampDb(db) - MIN_DB) / (MAX_DB - MIN_DB);
}

export function yToDb(y: number): number {
  return clampDb(MIN_DB + (1 - y) * (MAX_DB - MIN_DB));
}
