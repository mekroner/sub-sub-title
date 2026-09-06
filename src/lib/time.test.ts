import { describe, expect, it } from "vitest";
import { MIN_READABLE_DURATION, charsPerSecond, durationForText } from "./time";

describe("durationForText", () => {
  it("is the inverse of charsPerSecond for text long enough to matter", () => {
    const text = "x".repeat(100);
    const duration = durationForText(text, 17);
    expect(charsPerSecond(text, 0, duration)).toBeCloseTo(17, 6);
  });

  it("counts characters the way charsPerSecond does", () => {
    // Newlines and runs of whitespace collapse to a single character.
    expect(durationForText("ab cd", 1)).toBe(durationForText("ab\ncd", 1));
    expect(durationForText("  ab   cd  ", 1)).toBe(5);
  });

  it("holds a short cue on screen for at least a beat", () => {
    expect(durationForText("Hi.", 17)).toBe(MIN_READABLE_DURATION);
  });

  it("needs no time for empty text, and refuses a nonsense reading speed", () => {
    expect(durationForText("", 17)).toBe(0);
    expect(durationForText("   ", 17)).toBe(0);
    expect(durationForText("hello", 0)).toBe(0);
    expect(durationForText("hello", -5)).toBe(0);
  });
});
