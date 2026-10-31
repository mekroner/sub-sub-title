import { describe, expect, it } from "vitest";

import type { Cue, GainPoint } from "../types";
import fixtures from "./automation.fixtures.json";
import {
  MIN_POINT_GAP,
  addPoint,
  cueDuckCurve,
  curveDb,
  dbToY,
  duckCurve,
  movePoint,
  removePoint,
  yToDb,
} from "./automation";
import { DEFAULT_DUCK, defaultVoiceover, patchDuck, toggleCueDuck } from "./voiceover";

const duck: GainPoint[] = [
  { time: 1, db: 0 },
  { time: 1.2, db: -20 },
  { time: 3, db: -20 },
  { time: 3.4, db: 0 },
];

describe("curveDb", () => {
  it("is 0 dB with no points and holds flat beyond the ends", () => {
    expect(curveDb([], 5)).toBe(0);
    expect(curveDb(duck, 0)).toBe(0);
    expect(curveDb(duck, 99)).toBe(0);
    expect(curveDb([{ time: 2, db: -6 }], 0)).toBe(-6);
  });

  it("passes through every point", () => {
    for (const p of duck) expect(curveDb(duck, p.time)).toBeCloseTo(p.db, 9);
  });

  it("never overshoots its neighbours", () => {
    for (let t = 0.9; t <= 3.5; t += 0.005) {
      const db = curveDb(duck, t);
      expect(db).toBeLessThanOrEqual(1e-9);
      expect(db).toBeGreaterThanOrEqual(-20 - 1e-9);
    }
  });

  it("is monotone between monotone points", () => {
    const ramp: GainPoint[] = [
      { time: 0, db: 0 },
      { time: 1, db: -3 },
      { time: 1.1, db: -30 },
      { time: 4, db: -31 },
    ];
    let previous = Infinity;
    for (let t = 0; t <= 4; t += 0.01) {
      const db = curveDb(ramp, t);
      expect(db).toBeLessThanOrEqual(previous + 1e-9);
      previous = db;
    }
  });

  it("matches the shared fixtures the export mixer is checked against", () => {
    for (const fixture of fixtures.cases) {
      fixture.samples.forEach(([time, expected]) => {
        expect(curveDb(fixture.points, time)).toBeCloseTo(expected, 9);
      });
    }
  });
});

describe("editing points", () => {
  it("inserts in time order and reports the index", () => {
    const { points, index } = addPoint(duck, { time: 2, db: -10 });
    expect(index).toBe(2);
    expect(points.map((p) => p.time)).toEqual([1, 1.2, 2, 3, 3.4]);
  });

  it("replaces a point dropped onto another instead of stacking", () => {
    const { points, index } = addPoint(duck, { time: 1.2 + MIN_POINT_GAP / 2, db: -6 });
    expect(points).toHaveLength(4);
    expect(points[index]).toEqual({ time: 1.2, db: -6 });
  });

  it("keeps a dragged point between its neighbours", () => {
    const moved = movePoint(duck, 1, { time: 10, db: -100 });
    expect(moved[1].time).toBeCloseTo(3 - MIN_POINT_GAP, 9);
    expect(moved[1].db).toBe(-60);
    expect(movePoint(duck, 1, { time: 1.2, db: -20 })).toBe(duck);
  });

  it("removes a point", () => {
    expect(removePoint(duck, 0).map((p) => p.time)).toEqual([1.2, 3, 3.4]);
    expect(removePoint(duck, 9)).toBe(duck);
  });

  it("maps dB to a lane position and back", () => {
    for (const db of [-60, -20, 0, 12]) expect(yToDb(dbToY(db))).toBeCloseTo(db, 9);
    expect(dbToY(12)).toBe(0);
    expect(dbToY(-60)).toBe(1);
  });
});

describe("duckCurve", () => {
  const options = { depthDb: -15, attack: 0.2, release: 0.5, bridge: 0.5 };

  it("fades down before a region and up after it", () => {
    expect(duckCurve([{ start: 2, end: 4 }], options)).toEqual([
      { time: 1.8, db: 0 },
      { time: 2, db: -15 },
      { time: 4, db: -15 },
      { time: 4.5, db: 0 },
    ]);
  });

  it("bridges a short gap rather than bobbing up for it", () => {
    const points = duckCurve(
      [
        { start: 5, end: 6 },
        { start: 2, end: 4 },
      ],
      options,
    );
    expect(points.map((p) => p.time)).toEqual([1.8, 2, 6, 6.5]);
  });

  it("keeps separate regions apart, with strictly increasing times", () => {
    const points = duckCurve(
      [
        { start: 2, end: 3 },
        { start: 6, end: 7 },
      ],
      options,
    );
    expect(points).toHaveLength(8);
    for (let i = 1; i < points.length; i++) {
      expect(points[i].time).toBeGreaterThan(points[i - 1].time);
    }
  });

  it("starts already ducked when a region is too close to zero to fade", () => {
    const points = duckCurve([{ start: 0.1, end: 1 }], options);
    expect(points[0]).toEqual({ time: 0, db: -15 });
  });

  it("keeps times strictly increasing with zero-length fades", () => {
    const sharp = duckCurve([{ start: 2, end: 3 }], { ...options, attack: 0, release: 0 });
    for (let i = 1; i < sharp.length; i++) {
      expect(sharp[i].time).toBeGreaterThan(sharp[i - 1].time);
    }
  });

  it("ignores empty regions and works with the defaults", () => {
    expect(duckCurve([{ start: 1, end: 1 }], DEFAULT_DUCK)).toEqual([]);
    expect(duckCurve([{ start: 1, end: 2 }], DEFAULT_DUCK)).toHaveLength(4);
  });
});

describe("cueDuckCurve", () => {
  const cue = (id: string, start: number, end: number): Cue => ({
    id,
    start,
    end,
    text: id,
    speakerId: null,
  });
  const cues = [cue("a", 2, 3), cue("b", 10, 11)];

  it("ducks under every cue by default", () => {
    const points = cueDuckCurve(defaultVoiceover(), cues);
    expect(curveDb(points, 2.5)).toBe(DEFAULT_DUCK.depthDb);
    expect(curveDb(points, 10.5)).toBe(DEFAULT_DUCK.depthDb);
    expect(curveDb(points, 6)).toBe(0);
  });

  it("lets the original through under a cue switched off", () => {
    const vo = toggleCueDuck(defaultVoiceover(), "b");
    const points = cueDuckCurve(vo, cues);
    expect(curveDb(points, 2.5)).toBe(DEFAULT_DUCK.depthDb);
    expect(curveDb(points, 10.5)).toBe(0);
    // And back on again.
    expect(curveDb(cueDuckCurve(toggleCueDuck(vo, "b"), cues), 10.5)).toBe(DEFAULT_DUCK.depthDb);
  });

  it("follows the settings, and is flat when ducking is off", () => {
    const deeper = patchDuck(defaultVoiceover(), { depthDb: -30 });
    expect(curveDb(cueDuckCurve(deeper, cues), 2.5)).toBe(-30);
    expect(cueDuckCurve(patchDuck(defaultVoiceover(), { enabled: false }), cues)).toEqual([]);
    expect(cueDuckCurve(patchDuck(defaultVoiceover(), { depthDb: 0 }), cues)).toEqual([]);
  });
});
