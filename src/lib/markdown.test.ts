import { describe, expect, it } from "vitest";

import { parseInline, parseMarkdown } from "./markdown";

describe("parseInline", () => {
  it("reads bold, italic and code", () => {
    expect(parseInline("a **b** *c* `d`")).toEqual([
      { kind: "text", text: "a " },
      { kind: "strong", children: [{ kind: "text", text: "b" }] },
      { kind: "text", text: " " },
      { kind: "em", children: [{ kind: "text", text: "c" }] },
      { kind: "text", text: " " },
      { kind: "code", text: "d" },
    ]);
  });

  it("nests italic inside bold", () => {
    expect(parseInline("**she *never* says it**")).toEqual([
      {
        kind: "strong",
        children: [
          { kind: "text", text: "she " },
          { kind: "em", children: [{ kind: "text", text: "never" }] },
          { kind: "text", text: " says it" },
        ],
      },
    ]);
  });

  it("leaves an unclosed marker as text while a reply streams", () => {
    expect(parseInline("This is **import")).toEqual([
      { kind: "text", text: "This is **import" },
    ]);
    expect(parseInline("a `half")).toEqual([{ kind: "text", text: "a `half" }]);
  });

  it("does not read arithmetic or snake_case as emphasis", () => {
    expect(parseInline("2 * 3 * 4")).toEqual([{ kind: "text", text: "2 * 3 * 4" }]);
    expect(parseInline("snake_case_name")).toEqual([{ kind: "text", text: "snake_case_name" }]);
  });
});

describe("parseMarkdown", () => {
  it("splits paragraphs on blank lines and keeps line breaks within one", () => {
    const blocks = parseMarkdown("one\ntwo\n\nthree");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      lines: [[{ kind: "text", text: "one" }], [{ kind: "text", text: "two" }]],
    });
  });

  it("reads bullet and numbered lists", () => {
    const blocks = parseMarkdown("Options:\n- first\n- **second**\n\n1. a\n2) b");
    expect(blocks[1]).toEqual({
      kind: "list",
      ordered: false,
      items: [
        [{ kind: "text", text: "first" }],
        [{ kind: "strong", children: [{ kind: "text", text: "second" }] }],
      ],
    });
    expect(blocks[2]).toMatchObject({ kind: "list", ordered: true });
    expect((blocks[2] as { items: unknown[] }).items).toHaveLength(2);
  });

  it("joins an indented continuation onto its list item", () => {
    const [list] = parseMarkdown("- a long\n  item");
    expect(list).toEqual({ kind: "list", ordered: false, items: [[{ kind: "text", text: "a long item" }]] });
  });

  it("reads headings, capping the level at three", () => {
    expect(parseMarkdown("#### Deep")).toEqual([
      { kind: "heading", level: 3, content: [{ kind: "text", text: "Deep" }] },
    ]);
  });

  it("keeps fenced code verbatim, even unclosed", () => {
    expect(parseMarkdown("```\n**not bold**\n```")).toEqual([
      { kind: "code", text: "**not bold**" },
    ]);
    expect(parseMarkdown("```\nstill coming")).toEqual([{ kind: "code", text: "still coming" }]);
  });
});
