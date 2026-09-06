import type { Speaker } from "../types";

/** The caption colour for a cue with no speaker. */
export const DEFAULT_CAPTION_COLOR = "#ffffff";

/**
 * Speaker colours. Chosen to stay distinguishable both as translucent waveform
 * regions and as caption text over arbitrary video.
 */
export const SPEAKER_PALETTE = [
  "#ffd400", // yellow — the conventional "first speaker" colour
  "#4fc3f7", // sky
  "#81c784", // green
  "#ff8a65", // coral
  "#ba68c8", // violet
  "#f06292", // pink
  "#4db6ac", // teal
  "#ffb74d", // amber
  "#9575cd", // indigo
];

export function nextPaletteColor(usedColors: string[]): string {
  const used = new Set(usedColors.map((c) => c.toLowerCase()));
  return (
    SPEAKER_PALETTE.find((c) => !used.has(c.toLowerCase())) ??
    SPEAKER_PALETTE[usedColors.length % SPEAKER_PALETTE.length]
  );
}

/** `#rrggbb` to its three channels, or null for anything unparseable. */
function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const int = parseInt(m[1], 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const channel = (c: number) =>
    Math.round(Math.min(255, Math.max(0, c)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** `#rrggbb` plus an alpha, as an `rgba()` string for waveform regions. */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return `rgba(255,255,255,${alpha})`;
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
}

/** Pick black or white text for a swatch, by perceived luminance. */
export function contrastText(hex: string): string {
  const rgb = parseHex(hex);
  if (!rgb) return "#000";
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
  return luminance > 0.45 ? "#000" : "#fff";
}

/** How far a muted variant is pulled towards grey, and then darkened. */
const MUTE_DESATURATE = 0.45;
const MUTE_DARKEN = 0.65;

/**
 * A dimmed, desaturated take on a colour — the default caption colour for a
 * speaker's thought cues. It keeps enough of the hue to still read as that
 * speaker, while being obviously quieter than their spoken lines.
 */
export function mutedVariant(hex: string): string {
  const rgb = parseHex(hex);
  if (!rgb) return "#9aa4b2";
  const grey = (rgb.r + rgb.g + rgb.b) / 3;
  const mix = (c: number) => (c + (grey - c) * MUTE_DESATURATE) * MUTE_DARKEN;
  return toHex({ r: mix(rgb.r), g: mix(rgb.g), b: mix(rgb.b) });
}

/**
 * The caption colour for a speaker's thought cues: their own choice when they
 * have made one, and a muted variant of their speaking colour otherwise. The
 * single place that fallback is decided.
 */
export function thoughtColor(speaker: Speaker | null | undefined): string {
  if (!speaker) return mutedVariant(DEFAULT_CAPTION_COLOR);
  return speaker.thinkingColor ?? mutedVariant(speaker.color);
}
