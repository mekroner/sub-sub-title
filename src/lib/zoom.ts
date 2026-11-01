/**
 * Timeline zoom, in pixels per second, shared by the Subtitles waveform and
 * the Voiceover and Edit timelines. The floor is low enough to fit hours of
 * timeline on a screen; steps are relative, so zooming is as smooth at 0.05
 * px/s as at 50.
 */

import { clamp } from "./time";

/** A three-hour timeline in about a hundred pixels. */
export const MIN_ZOOM = 0.01;
export const MAX_ZOOM = 600;
/** Multiplier per wheel notch; gentler than the keyboard's. */
export const WHEEL_ZOOM_STEP = 1.15;
/** Multiplier per zoom key press. */
export const KEY_ZOOM_STEP = 1.4;

/** Three significant figures: steady values, whatever the scale. */
export function roundZoom(zoom: number): number {
  if (!(zoom > 0)) return MIN_ZOOM;
  const magnitude = Math.pow(10, Math.floor(Math.log10(zoom)) - 2);
  return Math.round(zoom / magnitude) * magnitude;
}

/** `zoom` times `factor`, rounded and kept within the limits. */
export function stepZoom(zoom: number, factor: number): number {
  return clamp(roundZoom(zoom * factor), MIN_ZOOM, MAX_ZOOM);
}

/**
 * The zoom that shows `duration` seconds in `width` pixels, rounded down so it
 * still fits. Null when there is nothing to fit or nowhere to fit it.
 */
export function fitZoom(duration: number, width: number): number | null {
  if (!(duration > 0) || !(width > 0)) return null;
  const exact = width / duration;
  const rounded = roundZoom(exact);
  const fits = rounded > exact ? roundZoom(exact * 0.995) : rounded;
  return clamp(fits, MIN_ZOOM, MAX_ZOOM);
}

/** Steps on a zoom slider; it runs on a log scale, so every decade gets equal room. */
export const SLIDER_STEPS = 1000;

export function zoomToSlider(zoom: number): number {
  const span = Math.log(MAX_ZOOM) - Math.log(MIN_ZOOM);
  return Math.round(((Math.log(clamp(zoom, MIN_ZOOM, MAX_ZOOM)) - Math.log(MIN_ZOOM)) / span) * SLIDER_STEPS);
}

export function sliderToZoom(value: number): number {
  const span = Math.log(MAX_ZOOM) - Math.log(MIN_ZOOM);
  return stepZoom(Math.exp(Math.log(MIN_ZOOM) + (clamp(value, 0, SLIDER_STEPS) / SLIDER_STEPS) * span), 1);
}
