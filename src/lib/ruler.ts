/**
 * Timeline rulers: the tick spacing that leaves room for a label, the label,
 * and a canvas sized for the screen's pixel ratio. Shared by the Voiceover and
 * Edit timelines.
 */

/** Ruler steps, in seconds; the smallest that leaves room for a label wins. */
export const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
export const MIN_TICK_PX = 70;

/** Seconds between ticks at `zoom` pixels per second. */
export function tickStep(zoom: number): number {
  return TICK_STEPS.find((s) => s * zoom >= MIN_TICK_PX) ?? 3600;
}

export function formatTick(seconds: number, step: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  const text = step < 1 ? s.toFixed(1) : String(Math.round(s));
  return `${m}:${text.padStart(step < 1 ? 4 : 2, "0")}`;
}

/** Sizes the canvas's backing store for the screen and returns a cleared context. */
export function prepareCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): CanvasRenderingContext2D | null {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  // CSS size is left to the caller: a clip's canvas stretches to the clip.
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  g.clearRect(0, 0, width, height);
  return g;
}
