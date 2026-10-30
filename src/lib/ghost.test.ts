import { describe, expect, it } from "vitest";

import type { Cue, Speaker } from "../types";
import {
  GhostCache,
  advanceGhost,
  buildGhostPrompt,
  maxTokensForBudget,
  nextGhostWord,
  reconcileGhost,
} from "./ghost";
import type { GhostInput } from "./ghost";

const LIMITS = { targetCps: 17, maxCharsPerLine: 42, maxLines: 2 };

const speakers: Speaker[] = [
  { id: "anna", name: "Anna", color: "#f00", voiceNotes: "clipped", innerVoice: "anxious" },
  { id: "ben", name: "Ben", color: "#0f0" },
];

const cue = (
  id: string,
  start: number,
  end: number,
  text: string,
  speakerId: string | null = null,
  thought = false,
): Cue => ({ id, start, end, text, speakerId, ...(thought ? { mode: "thought" as const } : {}) });

const CUES: Cue[] = [
  cue("a", 0, 2, "Where did the money go?", "ben"),
  cue("b", 2.5, 4, "He knows.", "anna", true),
  cue("c", 4.5, 7, "I spent", "anna"),
  cue("d", 7.5, 9, "On what?", "ben"),
  cue("e", 9.5, 11, "Don't.", "anna"),
];

function input(overrides: Partial<GhostInput> = {}): GhostInput {
  return {
    cues: CUES,
    speakers,
    cueId: "c",
    prefix: "I spent",
    linesBefore: 10,
    linesAfter: 1,
    limits: LIMITS,
    ...overrides,
  };
}

describe("buildGhostPrompt", () => {
  it("puts the cues around the typed line in order, marking where it is", () => {
    const prompt = buildGhostPrompt(input())!;
    const lines = prompt.user.split("\n");
    const at = (text: string) => lines.findIndex((l) => l.includes(text));
    expect(at("Where did the money go?")).toBeLessThan(at("He knows."));
    expect(at("He knows.")).toBeLessThan(at("Anna says: «TYPING»"));
    expect(at("Anna says: «TYPING»")).toBeLessThan(at("On what?"));
    expect(prompt.user).toContain("Anna thinks: He knows.");
  });

  it("keeps to the requested number of lines after the cue", () => {
    const prompt = buildGhostPrompt(input({ linesAfter: 1 }))!;
    expect(prompt.user).toContain("On what?");
    expect(prompt.user).not.toContain("Don't.");
  });

  it("puts the typed text last, so the stable part can be cached", () => {
    const prompt = buildGhostPrompt(input())!;
    expect(prompt.user.trimEnd().endsWith('"I spent"')).toBe(true);
    expect(prompt.user.indexOf("## Transcript")).toBeLessThan(
      prompt.user.indexOf("## The line being typed"),
    );
  });

  it("describes the speaker's voice and inner voice", () => {
    const prompt = buildGhostPrompt(input())!;
    expect(prompt.user).toContain("Voice: clipped");
    expect(prompt.user).toContain("Inner voice: anxious");
    expect(prompt.user).toContain("Anna says this line aloud.");
    expect(prompt.speakerName).toBe("Anna");
  });

  it("says when the line is a thought", () => {
    const cues = CUES.map((c) => (c.id === "c" ? { ...c, mode: "thought" as const } : c));
    const prompt = buildGhostPrompt(input({ cues }))!;
    expect(prompt.user).toContain("Anna thinks: «TYPING»");
    expect(prompt.user).toContain("private inner voice");
  });

  it("budgets by reading speed, minus what is typed", () => {
    // 2.5 s at 17 cps is 42 characters; "I spent" has used 7 of them.
    const prompt = buildGhostPrompt(input())!;
    expect(prompt.charBudget).toBe(35);
    expect(prompt.user).toContain("at most 42 characters in all, so add no more than 35");
    expect(prompt.maxTokens).toBe(maxTokensForBudget(35));
  });

  it("asks for the whole line when nothing is typed", () => {
    const prompt = buildGhostPrompt(input({ prefix: "" }))!;
    expect(prompt.user).toContain("Nothing typed yet");
  });

  it("asks nothing when the cue is already full, or gone", () => {
    expect(buildGhostPrompt(input({ prefix: "x".repeat(41) }))).toBeNull();
    expect(buildGhostPrompt(input({ cueId: "missing" }))).toBeNull();
  });
});

describe("reconcileGhost", () => {
  const opts = { charBudget: 40, speakerName: "Anna" };

  it("keeps a plain continuation of a new word", () => {
    expect(reconcileGhost("I spent", " it on the car.", opts)).toBe(" it on the car.");
  });

  it("continues a half-typed word without a space", () => {
    expect(reconcileGhost("I spe", "nt it all.", opts)).toBe("nt it all.");
  });

  it("strips the typed text when the model repeats the whole line", () => {
    expect(reconcileGhost("I spent", "I spent it on the car.", opts)).toBe(" it on the car.");
    expect(reconcileGhost("I spe", "i spent it.", opts)).toBe("nt it.");
  });

  it("does not double the space after a typed space", () => {
    expect(reconcileGhost("I spent ", " it on the car.", opts)).toBe("it on the car.");
  });

  it("adds a space after punctuation", () => {
    expect(reconcileGhost("Fine,", "whatever you say.", opts)).toBe(" whatever you say.");
  });

  it("joins punctuation flush", () => {
    expect(reconcileGhost("Fine", ", whatever.", opts)).toBe(", whatever.");
  });

  it("strips quotes, a speaker label and line breaks", () => {
    expect(reconcileGhost("", 'Anna: "It was\nfor you."', opts)).toBe("It was for you.");
  });

  it("returns null for an empty or echo-only reply", () => {
    expect(reconcileGhost("I spent", "   ", opts)).toBeNull();
    expect(reconcileGhost("I spent", "I spent", opts)).toBeNull();
  });

  it("cuts a reply that runs well past the budget back to a word", () => {
    const got = reconcileGhost("", "one two three four five six seven", {
      charBudget: 5,
    });
    // A budget of 5 plus the slack allows 13 characters: "one two three".
    expect(got).toBe("one two three");
  });
});

describe("advanceGhost", () => {
  const ghost = { prefix: "I spent", text: " it on the car." };

  it("shortens the ghost as its text is typed", () => {
    expect(advanceGhost(ghost, "I spent it")).toBe(" on the car.");
    expect(advanceGhost(ghost, "I spent")).toBe(" it on the car.");
  });

  it("returns empty once all of it has been typed", () => {
    expect(advanceGhost(ghost, "I spent it on the car.")).toBe("");
  });

  it("gives up when the typing goes elsewhere", () => {
    expect(advanceGhost(ghost, "I spent it in")).toBeNull();
    expect(advanceGhost(ghost, "I spen")).toBeNull();
  });
});

describe("nextGhostWord", () => {
  it("takes the leading space and one word", () => {
    expect(nextGhostWord(" it on the car.")).toBe(" it");
    expect(nextGhostWord("nt it.")).toBe("nt");
    expect(nextGhostWord("")).toBe("");
  });
});

describe("GhostCache", () => {
  it("evicts the least recently used entry", () => {
    const cache = new GhostCache(2);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.get("a");
    cache.set("c", "3");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("1");
    expect(cache.get("c")).toBe("3");
  });

  it("remembers that there was nothing to suggest", () => {
    const cache = new GhostCache();
    cache.set("k", null);
    expect(cache.get("k")).toBeNull();
  });
});
