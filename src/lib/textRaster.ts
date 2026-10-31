/**
 * Text items drawn to PNGs in the webview. The preview shows the PNG and the
 * bake overlays the very same bytes, so the two can never disagree on a glyph
 * — and ffmpeg never needs the fonts, or `drawtext` and its escaping.
 */

import type { TextStyle } from "../types";
import { hashString } from "./editPlan";

/** Line spacing, as a multiple of the font size. */
export const LINE_HEIGHT = 1.2;
/** Largest side of a drawn text image; the canvas would refuse more. */
export const MAX_TEXT_PX = 8192;

export interface LineMetrics {
  width: number;
  /** The font's ascent and descent at this size, the same for every line. */
  ascent: number;
  descent: number;
}

export type Measure = (line: string) => LineMetrics;

export interface TextLayout {
  width: number;
  height: number;
  /** The background box, when the style has one. */
  box: { x: number; y: number; w: number; h: number } | null;
  /** Where each line is drawn: x is its anchor for `align`, y its baseline. */
  lines: Array<{ text: string; x: number; y: number }>;
}

export function fontString(style: TextStyle): string {
  const family = style.fontFamily.replace(/"/g, "");
  return `${style.weight} ${style.fontSize}px "${family}", sans-serif`;
}

/** Room around the background box for the outline and the shadow to spill into. */
export function effectMargin(style: TextStyle): number {
  const outline = style.outline?.width ?? 0;
  const shadow = style.shadow
    ? 2 * style.shadow.blur + Math.max(Math.abs(style.shadow.dx), Math.abs(style.shadow.dy))
    : 0;
  return Math.ceil(outline + shadow);
}

/**
 * Where everything goes. Pure: the measuring is passed in, so this can be
 * tested without a canvas. Returns null for text with nothing to draw.
 */
export function textLayout(text: string, style: TextStyle, measure: Measure): TextLayout | null {
  if (text.trim() === "") return null;
  const lines = text.split(/\r?\n/);
  const metrics = lines.map((line) => measure(line));
  const lineHeight = style.fontSize * LINE_HEIGHT;
  const textW = Math.ceil(Math.max(...metrics.map((m) => m.width)));
  const textH = Math.ceil(lines.length * lineHeight);
  const pad = style.background ? Math.ceil(style.background.padding) : 0;
  const margin = effectMargin(style);

  const width = Math.min(MAX_TEXT_PX, Math.max(1, textW + 2 * (pad + margin)));
  const height = Math.min(MAX_TEXT_PX, Math.max(1, textH + 2 * (pad + margin)));
  const left = margin + pad;
  const top = margin + pad;
  const { ascent, descent } = metrics[0];
  // Each line's glyphs sit in the middle of its line box.
  const baselineInLine = (lineHeight - (ascent + descent)) / 2 + ascent;
  const anchor = style.align === "left" ? left : style.align === "right" ? left + textW : left + textW / 2;

  return {
    width,
    height,
    box: style.background ? { x: margin, y: margin, w: textW + 2 * pad, h: textH + 2 * pad } : null,
    lines: lines.map((line, i) => ({ text: line, x: anchor, y: top + i * lineHeight + baselineInLine })),
  };
}

/** Identifies a drawing: the same text in the same style is the same image. */
export function rasterKey(text: string, style: TextStyle): string {
  return hashString(JSON.stringify({ text, style }));
}

export interface DrawnText {
  key: string;
  /** The name it is staged under for a bake. */
  name: string;
  width: number;
  height: number;
  bytes: Uint8Array;
  /** An object URL for the preview. */
  url: string;
}

const cache = new Map<string, Promise<DrawnText | null>>();

/** Draws the text to a PNG, once per text and style. */
export function rasterText(text: string, style: TextStyle): Promise<DrawnText | null> {
  const key = rasterKey(text, style);
  let pending = cache.get(key);
  if (!pending) {
    pending = draw(text, style, key).catch(() => null);
    cache.set(key, pending);
  }
  return pending;
}

/** Forgets drawings no item uses any more, and frees their URLs. */
export function releaseRasters(keep: ReadonlySet<string>): void {
  for (const [key, pending] of cache) {
    if (keep.has(key)) continue;
    cache.delete(key);
    void pending.then((drawn) => drawn && URL.revokeObjectURL(drawn.url));
  }
}

async function draw(text: string, style: TextStyle, key: string): Promise<DrawnText | null> {
  const font = fontString(style);
  // A font not yet used on the page may not be ready to measure.
  await document.fonts.load(font, text).catch(() => undefined);

  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.font = font;
  const sample = g.measureText("Hg");
  const ascent = sample.fontBoundingBoxAscent || style.fontSize * 0.8;
  const descent = sample.fontBoundingBoxDescent || style.fontSize * 0.2;
  const layout = textLayout(text, style, (line) => ({ width: g.measureText(line).width, ascent, descent }));
  if (!layout) return null;

  canvas.width = layout.width;
  canvas.height = layout.height;
  // Resizing a canvas resets its state.
  g.font = font;
  g.textBaseline = "alphabetic";
  g.textAlign = style.align;

  if (layout.box && style.background) {
    g.fillStyle = style.background.color;
    g.fillRect(layout.box.x, layout.box.y, layout.box.w, layout.box.h);
  }
  // The shadow goes on the first pass that draws glyphs, and only that one.
  const shadow = () => {
    if (!style.shadow) return;
    g.shadowColor = style.shadow.color;
    g.shadowBlur = style.shadow.blur;
    g.shadowOffsetX = style.shadow.dx;
    g.shadowOffsetY = style.shadow.dy;
  };
  const noShadow = () => {
    g.shadowColor = "transparent";
    g.shadowBlur = 0;
    g.shadowOffsetX = 0;
    g.shadowOffsetY = 0;
  };

  shadow();
  if (style.outline && style.outline.width > 0) {
    // Strokes straddle the glyph edge, so twice the width shows outside it.
    g.lineJoin = "round";
    g.miterLimit = 2;
    g.lineWidth = style.outline.width * 2;
    g.strokeStyle = style.outline.color;
    for (const line of layout.lines) g.strokeText(line.text, line.x, line.y);
    noShadow();
  }
  g.fillStyle = style.color;
  for (const line of layout.lines) g.fillText(line.text, line.x, line.y);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    key,
    name: `t-${key}.png`,
    width: layout.width,
    height: layout.height,
    bytes,
    url: URL.createObjectURL(blob),
  };
}
