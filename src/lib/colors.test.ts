import { describe, expect, it } from "vitest";
import type { Speaker } from "../types";
import { contrastText, mutedVariant, thoughtColor, withAlpha } from "./colors";

const speaker = (extra: Partial<Speaker> = {}): Speaker => ({
  id: "m",
  name: "Mike",
  color: "#4fc3f7",
  ...extra,
});

describe("mutedVariant", () => {
  it("returns a valid, different colour", () => {
    const muted = mutedVariant("#4fc3f7");
    expect(muted).toMatch(/^#[0-9a-f]{6}$/);
    expect(muted).not.toBe("#4fc3f7");
  });

  it("is darker than what it came from", () => {
    // contrastText flips to white once a colour is dark enough to need it.
    expect(contrastText("#ffd400")).toBe("#000");
    expect(contrastText(mutedVariant("#ffd400"))).toBe("#fff");
  });

  it("is stable, so the same speaker always gets the same thought colour", () => {
    expect(mutedVariant("#4fc3f7")).toBe(mutedVariant("#4fc3f7"));
  });

  it("falls back rather than throwing on a malformed value", () => {
    expect(mutedVariant("nope")).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("thoughtColor", () => {
  it("prefers the speaker's own choice", () => {
    expect(thoughtColor(speaker({ thinkingColor: "#334455" }))).toBe("#334455");
  });

  it("derives one when they have not chosen", () => {
    expect(thoughtColor(speaker())).toBe(mutedVariant("#4fc3f7"));
  });

  it("still gives a colour for a cue with no speaker", () => {
    expect(thoughtColor(null)).toMatch(/^#[0-9a-f]{6}$/);
    expect(thoughtColor(undefined)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("withAlpha", () => {
  it("keeps working after the shared hex parse", () => {
    expect(withAlpha("#4fc3f7", 0.22)).toBe("rgba(79,195,247,0.22)");
    expect(withAlpha("nope", 0.5)).toBe("rgba(255,255,255,0.5)");
  });
});
