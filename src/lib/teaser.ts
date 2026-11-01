/**
 * Teasers: the finished video up to a cutoff, then a short screen made from an
 * overlay template over black. The pure parts — which cues make the cut, and
 * the screen as an edit of its own — live here; the dialog stages and renders.
 */

import type { Cue, Edit, EditCanvas } from "../types";
import { mainTrack } from "./edit";
import { instantiateTemplate, type OverlayTemplate } from "./template";

/** Shorter than this left at the cutoff is not worth showing. */
const MIN_CUE_SECONDS = 0.05;

/** The cues a teaser shows: those that start before the cutoff, ended at it. */
export function cuesForTeaser(cues: Cue[], at: number): Cue[] {
  return cues
    .filter((c) => c.start < at - MIN_CUE_SECONDS)
    .map((c) => (c.end > at ? { ...c, end: at } : c));
}

/**
 * The post-teaser screen as an edit of its own: the template at time zero
 * over black, on the video's canvas. Its images are named, not pathed: they
 * are staged under those names in the render's work dir.
 */
export function teaserScreenEdit(canvas: EditCanvas, template: OverlayTemplate | null): Edit {
  const blank: Edit = { canvas, sources: [], tracks: [mainTrack()], items: [] };
  if (!template) return blank;
  const names = new Map(Object.keys(template.images).map((name) => [name, name]));
  return instantiateTemplate(blank, template, 0, names).edit;
}

/** Where a teaser goes by default: beside the burn-in, named for what it is. */
export function teaserOutputPath(burnedPath: string): string {
  return burnedPath.replace(/\.subtitled\.mp4$/i, "").replace(/\.mp4$/i, "") + ".teaser.mp4";
}
