import { describe, expect, it } from "vitest";

import type { TextStyle } from "../types";
import { effectMargin, fontString, rasterKey, textLayout, type Measure } from "./textRaster";

const style: TextStyle = {
  fontFamily: "Arial",
  fontSize: 100,
  color: "#fff",
  weight: 700,
  align: "center",
};

/** Ten pixels per character, an 80/20 ascent and descent. */
const measure: Measure = (line) => ({ width: line.length * 10, ascent: 80, descent: 20 });

describe("textLayout", () => {
  it("sizes a single line to its text, with the glyphs centred in the line box", () => {
    const layout = textLayout("Hello", style, measure)!;
    expect(layout).toMatchObject({ width: 50, height: 120, box: null });
    expect(layout.lines).toEqual([{ text: "Hello", x: 25, y: 90 }]);
  });

  it("stacks lines and aligns them inside the widest", () => {
    const left = textLayout("Hi\nThere", { ...style, align: "left" }, measure)!;
    expect(left.width).toBe(50);
    expect(left.height).toBe(240);
    expect(left.lines.map((l) => [l.x, l.y])).toEqual([
      [0, 90],
      [0, 210],
    ]);
    const right = textLayout("Hi\nThere", { ...style, align: "right" }, measure)!;
    expect(right.lines[0].x).toBe(50);
  });

  it("leaves room for the background, the outline and the shadow", () => {
    const decorated: TextStyle = {
      ...style,
      outline: { color: "#000", width: 4 },
      shadow: { color: "#000", blur: 3, dx: 5, dy: -2 },
      background: { color: "#222", padding: 10 },
    };
    expect(effectMargin(decorated)).toBe(15);
    const layout = textLayout("Hello", decorated, measure)!;
    expect(layout.width).toBe(50 + 2 * (10 + 15));
    expect(layout.height).toBe(120 + 2 * (10 + 15));
    expect(layout.box).toEqual({ x: 15, y: 15, w: 70, h: 140 });
    expect(layout.lines[0]).toMatchObject({ x: 25 + 25, y: 90 + 25 });
  });

  it("draws nothing for blank text", () => {
    expect(textLayout("  \n ", style, measure)).toBeNull();
  });
});

describe("text identity", () => {
  it("names the same text in the same style the same", () => {
    expect(rasterKey("Hi", style)).toBe(rasterKey("Hi", { ...style }));
    expect(rasterKey("Hi", style)).not.toBe(rasterKey("Hi", { ...style, color: "#000" }));
    // Staged names must pass the backend's check: lowercase ASCII, digits, dash.
    expect(`t-${rasterKey("Hi", style)}.png`).toMatch(/^[a-z0-9_-]+\.png$/);
  });

  it("writes a CSS font with the family quoted and a fallback", () => {
    expect(fontString({ ...style, fontFamily: 'Segoe "UI"' })).toBe('700 100px "Segoe UI", sans-serif');
  });
});
