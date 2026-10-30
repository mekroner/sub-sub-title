/**
 * Just enough markdown for chat replies: paragraphs, headings, lists, fenced
 * code, and bold / italic / inline code inside them.
 *
 * It produces tokens, never HTML, so a reply cannot inject markup. It has to
 * cope with half a reply while one streams: an unclosed marker stays literal
 * text until its partner arrives.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "code"; text: string };

export type Block =
  | { kind: "paragraph"; lines: Inline[][] }
  | { kind: "heading"; level: 1 | 2 | 3; content: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "code"; text: string };

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const FENCE = /^\s*```/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", lines: paragraph.map(parseInline) });
      paragraph = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (FENCE.test(line)) {
      flushParagraph();
      const body: string[] = [];
      i++;
      // A fence still streaming has no closer yet; show what there is.
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      const level = Math.min(3, heading[1].length) as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, content: parseInline(heading[2].trim()) });
      i++;
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      const pattern = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (i < lines.length) {
        const match = pattern.exec(lines[i]);
        if (match) {
          items.push(match[1]);
        } else if (items.length > 0 && /^\s{2,}\S/.test(lines[i])) {
          // An indented line continues the item above it.
          items[items.length - 1] += ` ${lines[i].trim()}`;
        } else {
          break;
        }
        i++;
      }
      blocks.push({ kind: "list", ordered, items: items.map(parseInline) });
      continue;
    }

    paragraph.push(line);
    i++;
  }
  flushParagraph();
  return blocks;
}

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flushText = () => {
    if (text) out.push({ kind: "text", text });
    text = "";
  };

  let i = 0;
  while (i < source.length) {
    if (source[i] === "`") {
      const close = source.indexOf("`", i + 1);
      if (close > i + 1) {
        flushText();
        out.push({ kind: "code", text: source.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }

    if (source.startsWith("**", i) || source.startsWith("__", i)) {
      const marker = source.slice(i, i + 2);
      const close = source.indexOf(marker, i + 2);
      if (close > i + 2) {
        flushText();
        out.push({ kind: "strong", children: parseInline(source.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    const ch = source[i];
    if ((ch === "*" || ch === "_") && opensEmphasis(source, i)) {
      const close = findEmphasisClose(source, i + 1, ch);
      if (close > 0) {
        flushText();
        out.push({ kind: "em", children: parseInline(source.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    }

    text += ch;
    i++;
  }
  flushText();
  return out;
}

/** `*word*` opens; `2 * 3` and `snake_case` do not. */
function opensEmphasis(source: string, at: number): boolean {
  const next = source[at + 1];
  if (!next || /\s/.test(next)) return false;
  const prev = source[at - 1];
  return !prev || !/[\p{L}\p{N}]/u.test(prev);
}

function findEmphasisClose(source: string, from: number, marker: string): number {
  for (let i = from; i < source.length; i++) {
    if (source[i] !== marker) continue;
    // Skip a doubled marker: that is bold, not the end of this emphasis.
    if (source[i + 1] === marker) {
      i++;
      continue;
    }
    const prev = source[i - 1];
    const next = source[i + 1];
    if (prev && !/\s/.test(prev) && (!next || !/[\p{L}\p{N}]/u.test(next))) return i;
  }
  return -1;
}
