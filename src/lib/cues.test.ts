import { describe, expect, it } from "vitest";
import type { Cue } from "../types";
import {
  findActiveCueIndex,
  mergeWithNext,
  nudgeCue,
  slotAfter,
  splitCueAt,
} from "./cues";

const cue = (id: string, start: number, end: number, text = "text"): Cue => ({
  id,
  start,
  end,
  text,
  speakerId: null,
});

const LIST = [cue("a", 0, 2), cue("b", 3, 5), cue("c", 6, 10)];

describe("findActiveCueIndex", () => {
  it("finds the cue covering a time", () => {
    expect(findActiveCueIndex(LIST, 1)).toBe(0);
    expect(findActiveCueIndex(LIST, 4)).toBe(1);
    expect(findActiveCueIndex(LIST, 9.9)).toBe(2);
  });

  it("returns -1 inside a gap or past the end", () => {
    expect(findActiveCueIndex(LIST, 2.5)).toBe(-1);
    expect(findActiveCueIndex(LIST, 99)).toBe(-1);
  });

  it("treats the end boundary as exclusive", () => {
    expect(findActiveCueIndex(LIST, 2)).toBe(-1);
    expect(findActiveCueIndex(LIST, 3)).toBe(1);
  });

  it("handles an empty list", () => {
    expect(findActiveCueIndex([], 5)).toBe(-1);
  });
});

describe("splitCueAt", () => {
  it("splits timing and text at the playhead", () => {
    const list = [cue("a", 0, 4, "hello there world")];
    const { cues, newCueId } = splitCueAt(list, "a", 2);
    expect(cues).toHaveLength(2);
    expect(cues[0].end).toBe(2);
    expect(cues[1].start).toBe(2);
    expect(newCueId).toBe(cues[1].id);
    expect(`${cues[0].text} ${cues[1].text}`).toBe("hello there world");
  });

  it("prefers an existing line break as the split point", () => {
    const list = [cue("a", 0, 4, "first line\nsecond line")];
    const { cues } = splitCueAt(list, "a", 2);
    expect(cues[0].text).toBe("first line");
    expect(cues[1].text).toBe("second line");
  });

  it("refuses a split that would create a zero-length cue", () => {
    const list = [cue("a", 0, 4, "hello world")];
    expect(splitCueAt(list, "a", 0.01).newCueId).toBeNull();
    expect(splitCueAt(list, "a", 3.99).newCueId).toBeNull();
  });
});

describe("mergeWithNext", () => {
  it("joins two cues and their text", () => {
    const merged = mergeWithNext(LIST, "a");
    expect(merged).toHaveLength(2);
    expect(merged[0].start).toBe(0);
    expect(merged[0].end).toBe(5);
    expect(merged[0].text).toBe("text\ntext");
  });

  it("is a no-op on the last cue", () => {
    expect(mergeWithNext(LIST, "c")).toBe(LIST);
  });
});

describe("nudgeCue", () => {
  it("moves one edge without crossing the other", () => {
    const moved = nudgeCue(LIST, "b", "start", -1, 20);
    expect(moved[1].start).toBe(2);
    expect(moved[1].end).toBe(5);
  });

  it("clamps a start that would pass the end", () => {
    const moved = nudgeCue(LIST, "b", "start", 99, 20);
    expect(moved[1].start).toBeLessThan(moved[1].end);
  });

  it("shifts both edges keeping the duration", () => {
    const moved = nudgeCue(LIST, "b", "both", 1, 20);
    expect(moved[1].start).toBe(4);
    expect(moved[1].end).toBe(6);
  });

  it("does not push a cue past the end of the media", () => {
    const moved = nudgeCue(LIST, "c", "end", 99, 10);
    expect(moved[2].end).toBeLessThanOrEqual(10);
  });
});

describe("slotAfter", () => {
  it("fits a new cue into the gap after the given one", () => {
    const slot = slotAfter(LIST, "a", 20);
    expect(slot.start).toBeGreaterThanOrEqual(2);
    expect(slot.end).toBeLessThanOrEqual(3);
    expect(slot.end).toBeGreaterThan(slot.start);
  });

  it("defaults to two seconds when there is room", () => {
    const slot = slotAfter(LIST, "c", 60);
    expect(slot.end - slot.start).toBeCloseTo(2, 5);
  });
});
