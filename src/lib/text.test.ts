import { describe, expect, it } from "vitest";
import { lineStats, matchesQuery, replaceIn } from "./text";

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
