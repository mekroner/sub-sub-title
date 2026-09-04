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

/** `#rrggbb` plus an alpha, as an `rgba()` string for waveform regions. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(255,255,255,${alpha})`;
  const int = parseInt(m[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Pick black or white text for a swatch, by perceived luminance. */
export function contrastText(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#000";
  const int = parseInt(m[1], 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.45 ? "#000" : "#fff";
}
