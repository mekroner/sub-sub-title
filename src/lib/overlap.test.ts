import { describe, expect, it } from "vitest";
import type { Cue } from "../types";
import {
  duplicateCue,
  findOverlaps,
  insertCueClamped,
  joinCues,
  moveCueTo,
  moveCuesBy,
  resizeCue,
  resolveOverlaps,
} from "./cues";

const cue = (id: string, start: number, end: number, text = "text"): Cue => ({
  id,
  start,
  end,
  text,
  speakerId: null,
});

/** a: 0–2, b: 3–5, c: 6–10 */
const LIST = [cue("a", 0, 2), cue("b", 3, 5), cue("c", 6, 10)];
const GAP = 0.1;

const byId = (list: Cue[], id: string) => list.find((c) => c.id === id)!;

describe("resizeCue", () => {
  it("clamps an end against the next cue, leaving the gap", () => {
    const next = resizeCue(LIST, "a", 0, 4, 20, GAP);
    expect(byId(next, "a").end).toBeCloseTo(2.9, 5);
  });

  it("clamps a start against the previous cue", () => {
    const next = resizeCue(LIST, "b", 1, 5, 20, GAP);
    expect(byId(next, "b").start).toBeCloseTo(2.1, 5);
  });

  it("keeps the last cue inside the media", () => {
    const next = resizeCue(LIST, "c", 6, 99, 10, GAP);
    expect(byId(next, "c").end).toBeCloseTo(10, 5);
  });

  it("returns the same list when nothing moved", () => {
    expect(resizeCue(LIST, "b", 3, 5, 20, GAP)).toBe(LIST);
  });
});

describe("moveCueTo", () => {
  it("clamps a move inside the gap it stays in", () => {
    const next = moveCueTo(LIST, "a", 2.5, 20, GAP);
    // 0–2 dragged to 2.5 would run into b at 3: it stops at 2.9 − its width.
    expect(byId(next, "a").end).toBeCloseTo(2.9, 5);
    expect(byId(next, "a").end - byId(next, "a").start).toBeCloseTo(2, 5);
  });

  it("stays on the near side while its midpoint is short of the neighbour's", () => {
    // x is 0–1; dropped at 1.4 its midpoint (1.9) is short of y's middle (2.5).
    const pair = [cue("x", 0, 1), cue("y", 2, 3)];
    const next = moveCueTo(pair, "x", 1.4, 20, GAP);
    expect(next.map((c) => c.id)).toEqual(["x", "y"]);
    expect(byId(next, "x").end).toBeCloseTo(1.9, 5);
  });

  it("carries a cue across a neighbour once its midpoint clears it", () => {
    // Dropped at 2.4 the midpoint (2.9) is past y's middle, so x lands after it.
    const pair = [cue("x", 0, 1), cue("y", 2, 3)];
    const next = moveCueTo(pair, "x", 2.4, 20, GAP);
    expect(next.map((c) => c.id)).toEqual(["y", "x"]);
    expect(byId(next, "x").start).toBeCloseTo(3.1, 5);
  });

  it("keeps a cue's duration when it moves", () => {
    const next = moveCueTo(LIST, "c", 12, 20, GAP);
    expect(byId(next, "c").end - byId(next, "c").start).toBeCloseTo(4, 5);
  });

  it("snaps to the nearest gap wide enough to hold the cue", () => {
    // The 0.8s hole between b and c cannot take the 2s cue a, so a drag aimed
    // at it falls back to the nearest gap that can — here the one it came from,
    // pressed up against b.
    const next = moveCueTo(LIST, "a", 5.2, 20, GAP);
    expect(byId(next, "a").end).toBeCloseTo(2.9, 5);
  });

  it("refuses a move when no gap can hold the cue", () => {
    const packed = [cue("a", 0, 9.9), cue("b", 9.95, 10)];
    const next = moveCueTo(packed, "a", 5, 10, GAP);
    expect(byId(next, "a").start).toBeCloseTo(0, 5);
  });
});

describe("moveCuesBy", () => {
  it("shifts a selection as one block, keeping its spacing", () => {
    const next = moveCuesBy(LIST, ["a", "b"], 0.5, 20, GAP);
    expect(byId(next, "a").start).toBeCloseTo(0.5, 5);
    expect(byId(next, "b").start).toBeCloseTo(3.5, 5);
  });

  it("stops the block at the first unselected cue", () => {
    const next = moveCuesBy(LIST, ["a", "b"], 5, 20, GAP);
    expect(byId(next, "b").end).toBeCloseTo(5.9, 5);
    // The block kept its shape while being clamped.
    expect(byId(next, "b").start - byId(next, "a").end).toBeCloseTo(1, 5);
  });

  it("never lets a block jump over an unselected cue", () => {
    const next = moveCuesBy(LIST, ["a"], 8, 20, GAP);
    expect(byId(next, "a").end).toBeLessThanOrEqual(2.9);
  });
});

describe("findOverlaps and resolveOverlaps", () => {
  const overlapping = [cue("a", 0, 4), cue("b", 3, 6), cue("c", 6, 8)];

  it("finds the cue that starts too early", () => {
    expect(findOverlaps(overlapping).map((c) => c.id)).toEqual(["b"]);
  });

  it("trims the earlier cue where that leaves it readable", () => {
    const fixed = resolveOverlaps(overlapping, GAP);
    expect(byId(fixed, "a").end).toBeCloseTo(2.9, 5);
    expect(byId(fixed, "b").start).toBeCloseTo(3, 5);
    expect(findOverlaps(fixed, GAP)).toHaveLength(0);
  });

  it("pushes the later cue back when trimming would leave a stub", () => {
    const stub = [cue("a", 0, 4), cue("b", 0.02, 5)];
    const fixed = resolveOverlaps(stub, GAP);
    expect(byId(fixed, "b").start).toBeCloseTo(4.1, 5);
    expect(findOverlaps(fixed, GAP)).toHaveLength(0);
  });

  it("leaves a clean list untouched", () => {
    expect(resolveOverlaps(LIST, GAP)).toBe(LIST);
  });
});

describe("joinCues", () => {
  it("merges a contiguous run into one cue", () => {
    const list = [cue("a", 0, 2, "one"), cue("b", 3, 5, "two"), cue("c", 6, 10, "three")];
    const joined = joinCues(list, ["a", "b"])!;
    expect(joined).toHaveLength(2);
    expect(joined[0]).toMatchObject({ start: 0, end: 5, text: "one\ntwo" });
  });

  it("keeps the first speaker it finds", () => {
    const list = [
      { ...cue("a", 0, 2), speakerId: null },
      { ...cue("b", 3, 5), speakerId: "s1" },
    ];
    expect(joinCues(list, ["a", "b"])![0].speakerId).toBe("s1");
  });

  it("refuses a selection with a gap in it", () => {
    expect(joinCues(LIST, ["a", "c"])).toBeNull();
  });

  it("refuses a single cue", () => {
    expect(joinCues(LIST, ["a"])).toBeNull();
  });
});

describe("duplicateCue", () => {
  it("places the copy in the space after the original", () => {
    const { cues: next, newCueId } = duplicateCue(LIST, "c", 20, GAP);
    const copy = byId(next, newCueId!);
    expect(copy.start).toBeCloseTo(10.1, 5);
    expect(copy.end - copy.start).toBeCloseTo(4, 5);
    expect(findOverlaps(next, GAP)).toHaveLength(0);
  });

  it("shrinks the copy to fit a short gap", () => {
    const { cues: next, newCueId } = duplicateCue(LIST, "a", 20, GAP);
    expect(byId(next, newCueId!).end).toBeCloseTo(2.9, 5);
  });

  it("reports when there is no room at all", () => {
    const tight = [cue("a", 0, 2), cue("b", 2.05, 5)];
    expect(duplicateCue(tight, "a", 20, GAP).newCueId).toBeNull();
  });
});

describe("insertCueClamped", () => {
  it("trims a new cue to the room its neighbours leave", () => {
    const next = insertCueClamped(LIST, cue("new", 2.5, 4), 20, GAP)!;
    expect(byId(next, "new").end).toBeCloseTo(2.9, 5);
    expect(findOverlaps(next, GAP)).toHaveLength(0);
  });

  it("refuses when the neighbours leave no room", () => {
    const tight = [cue("a", 0, 2), cue("b", 2.05, 5)];
    expect(insertCueClamped(tight, cue("new", 2, 2.05), 20, GAP)).toBeNull();
  });
});
