import { describe, expect, it } from "vitest";
import type { CueIssue } from "../types";
import {
  applyReplacement,
  isSingleWord,
  issueSeverity,
  replacementLabel,
} from "./issues";

const issue = (patch: Partial<CueIssue> = {}): CueIssue => ({
  start: 6,
  end: 9,
  text: "teh",
  message: "Did you mean “the”?",
  kind: "Typo",
  replacements: ["the"],
  source: "harper",
  ...patch,
});

describe("issueSeverity", () => {
  it("treats both of Harper's misspelling kinds as spelling", () => {
    expect(issueSeverity(issue({ kind: "Typo" }))).toBe("spelling");
    expect(issueSeverity(issue({ kind: "Spelling" }))).toBe("spelling");
  });

  it("treats everything else offline as grammar", () => {
    expect(issueSeverity(issue({ kind: "Agreement" }))).toBe("grammar");
    expect(issueSeverity(issue({ kind: "Punctuation" }))).toBe("grammar");
  });

  it("marks an AI finding as a suggestion", () => {
    expect(issueSeverity(issue({ source: "ai", kind: "Correction" }))).toBe("suggestion");
  });
});

describe("applyReplacement", () => {
  it("splices the replacement into the span", () => {
    expect(applyReplacement("I ate teh cake.", issue(), "the")).toBe("I ate the cake.");
  });

  it("handles a removal", () => {
    expect(applyReplacement("I ate teh cake.", issue({ start: 6, end: 10 }), "")).toBe(
      "I ate cake.",
    );
  });

  it("replaces the whole cue for an AI correction", () => {
    const ai = issue({ start: 0, end: 15, source: "ai", replacements: ["fixed"] });
    expect(applyReplacement("I ate teh cake.", ai, "fixed")).toBe("fixed");
  });

  it("clamps a stale span rather than throwing", () => {
    expect(applyReplacement("short", issue({ start: 40, end: 90 }), "x")).toBe("shortx");
  });

  it("counts offsets the way the checker does, past an emoji", () => {
    const text = "🎬 teh scene";
    const at = text.indexOf("teh");
    expect(applyReplacement(text, issue({ start: at, end: at + 3 }), "the")).toBe(
      "🎬 the scene",
    );
  });
});

describe("replacementLabel", () => {
  it("names both sides of a replacement", () => {
    expect(replacementLabel(issue(), "the")).toBe("Replace “teh” with “the”");
  });

  it("says remove when the replacement is empty", () => {
    expect(replacementLabel(issue(), "")).toBe("Remove “teh”");
  });

  it("keeps AI corrections short", () => {
    expect(replacementLabel(issue({ source: "ai" }), "anything")).toBe("Apply correction");
  });
});

describe("isSingleWord", () => {
  it("is true for a lone word and false for a phrase", () => {
    expect(isSingleWord(issue({ text: "teh" }))).toBe(true);
    expect(isSingleWord(issue({ text: "their going" }))).toBe(false);
    expect(isSingleWord(issue({ text: "  " }))).toBe(false);
  });
});
