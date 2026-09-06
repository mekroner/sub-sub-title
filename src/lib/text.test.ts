import { describe, expect, it } from "vitest";
import {
  lineStats,
  matchesQuery,
  replaceIn,
  unwrapThought,
  wrapText,
  wrapThought,
} from "./text";

describe("lineStats", () => {
  it("counts each line separately", () => {
    const stats = lineStats("hello\nthere you", 42, 2);
    expect(stats.lines.map((l) => l.length)).toEqual([5, 9]);
    expect(stats.lineCount).toBe(2);
    expect(stats.longest).toBe(9);
  });

  it("flags a line exactly one character over the limit", () => {
    expect(lineStats("x".repeat(42), 42, 2).anyOver).toBe(false);
    expect(lineStats("x".repeat(43), 42, 2).anyOver).toBe(true);
  });

  it("ignores trailing spaces, which are invisible on screen", () => {
    expect(lineStats("abc   ", 42, 2).lines[0].length).toBe(3);
  });

  it("flags a cue with more lines than fit", () => {
    expect(lineStats("a\nb", 42, 2).tooManyLines).toBe(false);
    expect(lineStats("a\nb\nc", 42, 2).tooManyLines).toBe(true);
  });
});

describe("matchesQuery", () => {
  it("ignores case unless asked not to", () => {
    expect(matchesQuery("Hello there", "hello", false)).toBe(true);
    expect(matchesQuery("Hello there", "hello", true)).toBe(false);
  });

  it("treats the query as literal text, not a pattern", () => {
    expect(matchesQuery("who? me", "?", false)).toBe(true);
    expect(matchesQuery("who me", ".", false)).toBe(false);
  });

  it("never matches an empty query", () => {
    expect(matchesQuery("anything", "", false)).toBe(false);
  });
});

describe("replaceIn", () => {
  it("replaces every occurrence", () => {
    expect(replaceIn("a b a", "a", "c", true)).toBe("c b c");
  });

  it("keeps the surrounding text when matching case-insensitively", () => {
    expect(replaceIn("Anna and anna", "anna", "Bo", false)).toBe("Bo and Bo");
  });

  it("leaves text alone for an empty query", () => {
    expect(replaceIn("keep me", "", "x", false)).toBe("keep me");
  });
});

describe("wrapText", () => {
  it("leaves text that already fits on one line", () => {
    expect(wrapText("Hello there.", 42, 2)).toBe("Hello there.");
  });

  it("collapses the clipboard's own line breaks before re-flowing", () => {
    expect(wrapText("Hello there.\nHow are you?", 42, 2)).toBe(
      "Hello there. How are you?",
    );
    expect(wrapText("  spaced \t out \n\n text  ", 42, 2)).toBe("spaced out text");
  });

  it("balances two lines instead of filling the first to the brim", () => {
    // 50 characters: a brim-filling wrap would give 42 + 7.
    const text = "one two three four five six seven eight nine ten ok";
    const lines = wrapText(text, 42, 2).split("\n");
    expect(lines).toHaveLength(2);
    // Neither line runs away with the text.
    expect(Math.abs(lines[0].length - lines[1].length)).toBeLessThanOrEqual(6);
    expect(lines.join(" ")).toBe(text);
  });

  it("never exceeds the line budget, and keeps every word", () => {
    const text = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const lines = wrapText(text, 42, 2).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.join(" ")).toBe(text);
  });

  it("does not break inside a word that is longer than the limit", () => {
    expect(wrapText("antidisestablishmentarianism", 10, 2)).toBe(
      "antidisestablishmentarianism",
    );
  });

  it("returns an empty string for blank input", () => {
    expect(wrapText("", 42, 2)).toBe("");
    expect(wrapText("   \n  ", 42, 2)).toBe("");
  });
});

describe("thought markers", () => {
  it("wraps a whole cue once, however many lines", () => {
    expect(wrapThought("I'm so happy")).toBe("*I'm so happy*");
    expect(wrapThought("first line\nsecond line")).toBe("*first line\nsecond line*");
  });

  it("reads the text back out", () => {
    expect(unwrapThought("*I'm so happy*")).toBe("I'm so happy");
    expect(unwrapThought("*first line\nsecond line*")).toBe("first line\nsecond line");
  });

  it("round-trips", () => {
    for (const text of ["Hi.", "two\nlines", "punctuation, and — dashes"]) {
      expect(unwrapThought(wrapThought(text))).toBe(text);
    }
  });

  it("leaves ordinary text with emphasis in it alone", () => {
    expect(unwrapThought("*a* and *b*")).toBeNull();
    expect(unwrapThought("Hello")).toBeNull();
    expect(unwrapThought("*unclosed")).toBeNull();
    expect(unwrapThought("unopened*")).toBeNull();
  });

  it("treats empty and marker-only input as nothing to wrap", () => {
    expect(wrapThought("")).toBe("");
    expect(wrapThought("   ")).toBe("");
    expect(unwrapThought("**")).toBeNull();
    expect(unwrapThought("* *")).toBeNull();
  });
});
