/**
 * Turning an edit into a render plan: every decision made, in output pixels and
 * seconds, so the backend only has to translate it into an ffmpeg graph. The
 * plan's hash tells whether the last bake still matches the edit.
 */

import type { Edit, EditItem, PlanLayer, RenderPlan } from "../types";
import {
  editEnd,
  naturalSize,
  resolveRect,
  sourceOf,
  trackItems,
  type Size,
} from "./edit";

/** A text item drawn to a PNG: the name it is staged under, and its size. */
export interface TextRaster {
  name: string;
  width: number;
  height: number;
}

function layerFor(
  edit: Edit,
  item: EditItem,
  audible: boolean,
  rasters: ReadonlyMap<string, TextRaster>,
): PlanLayer | null {
  const source = sourceOf(edit, item);
  const raster = item.kind === "text" ? rasters.get(item.id) : undefined;
  const textSize: Size | undefined = raster ? { width: raster.width, height: raster.height } : undefined;
  const natural = naturalSize(item, edit.canvas, source, textSize);
  if (!natural) return null;
  if (item.kind !== "text" && !source) return null;

  const rects = item.transform.map((key) => ({
    time: key.time,
    ...resolveRect(natural, key, edit.canvas),
  }));
  const path = item.kind === "text" ? raster!.name : source!.path;
  const layer: PlanLayer = {
    kind: item.kind === "video" ? "video" : "image",
    path,
    staged: item.kind === "text",
    start: item.start,
    duration: item.duration,
    offset: item.kind === "video" ? item.offset : 0,
    fadeIn: item.fadeIn,
    fadeOut: item.fadeOut,
    opacity: item.opacity,
    rects,
  };
  if (item.kind === "video" && audible && source?.hasAudio) {
    layer.audio = { gainDb: item.gainDb };
  }
  return layer;
}

/**
 * The plan for the whole edit, bottom layer first. Hidden tracks draw nothing;
 * only the main track's video is heard, and not when the track is muted. Text
 * items without a raster are left out.
 */
export function buildRenderPlan(
  edit: Edit,
  rasters: ReadonlyMap<string, TextRaster> = new Map(),
): RenderPlan {
  const layers: PlanLayer[] = [];
  for (const track of edit.tracks) {
    if (track.hidden) continue;
    const audible = track.kind === "main" && !track.muted;
    for (const item of trackItems(edit, track.id)) {
      const layer = layerFor(edit, item, audible, rasters);
      if (layer) layers.push(layer);
    }
  }
  return {
    width: edit.canvas.width,
    height: edit.canvas.height,
    fps: edit.canvas.fps,
    total: editEnd(edit),
    layers,
  };
}

/** cyrb53: a fast 53-bit string hash. Not cryptographic; it only spots change. */
export function hashString(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * The plan's fingerprint. Numbers are rounded to the microsecond and the
 * micropixel, so float noise from a drag that went nowhere is not a change.
 */
export function planHash(plan: RenderPlan): string {
  const json = JSON.stringify(plan, (_key, value) =>
    typeof value === "number" ? Math.round(value * 1e6) / 1e6 : value,
  );
  return hashString(json);
}

/** Splits a path at its last separator, either kind. */
export function splitPath(path: string): { dir: string; base: string; sep: string } {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const sep = at >= 0 ? path[at] : path.includes("\\") ? "\\" : "/";
  return at >= 0
    ? { dir: path.slice(0, at), base: path.slice(at + 1), sep }
    : { dir: "", base: path, sep };
}

function stemOf(base: string): string {
  return base.replace(/\.[^.]+$/, "");
}

/**
 * Where a bake goes by default: beside the project file, named after it; or,
 * for an unsaved project, beside the first source.
 */
export function bakeBase(
  projectPath: string | null,
  edit: Edit,
): { dir: string; stem: string; sep: string } | null {
  const anchor = projectPath ?? edit.sources[0]?.path;
  if (!anchor) return null;
  const { dir, base, sep } = splitPath(anchor);
  // A re-bake of a bake should not grow ".cut.cut".
  return { dir, sep, stem: stemOf(base).replace(/\.cut(-\d+)?$/, "") };
}

/** `<stem>.cut.mp4`, then `.cut-2.mp4`, … — the first one `taken` says is free. */
export async function nextBakePath(
  base: { dir: string; stem: string; sep: string },
  taken: (path: string) => boolean | Promise<boolean>,
): Promise<string> {
  const prefix = base.dir ? `${base.dir}${base.sep}` : "";
  for (let n = 1; n < 1000; n++) {
    const candidate = `${prefix}${base.stem}.cut${n === 1 ? "" : `-${n}`}.mp4`;
    if (!(await taken(candidate))) return candidate;
  }
  return `${prefix}${base.stem}.cut-${Date.now()}.mp4`;
}

/** Normalises a path for comparison: separators, and case on Windows-style paths. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const unified = p.replace(/\\/g, "/");
    return /^[a-zA-Z]:\//.test(unified) ? unified.toLowerCase() : unified;
  };
  return norm(a) === norm(b);
}
