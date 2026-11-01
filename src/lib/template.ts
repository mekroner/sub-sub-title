/**
 * Overlay templates: a group of overlay items — text and stills — saved to a
 * file of their own, to be dropped into any edit again. A title card, a
 * lower third, a post-teaser screen.
 *
 * The file carries its images, as PNGs, so it still works when moved to
 * another folder or computer. Inserting one writes them out beside the
 * project and points image sources at them.
 */

import type { Edit, EditItem, EditTrack, ImageItem, TextItem, TransformKey } from "../types";
import {
  MIN_ITEM_SECONDS,
  addOverlayTrack,
  addSource,
  coerceKey,
  coerceStyle,
  itemEnd,
  scaleStyle,
} from "./edit";
import { makeId } from "./ids";

export const TEMPLATE_EXTENSION = "sstoverlay";

/** An embedded image: a PNG, base64-encoded. */
export interface TemplateImage {
  width: number;
  height: number;
  png: string;
}

/** An item as a template keeps it: no ids, its start relative to the template's. */
export type TemplateItem = Omit<ImageItem, "id" | "trackId" | "sourceId"> | Omit<TextItem, "id" | "trackId">;

export interface TemplateLayer {
  /** 0 is the lowest overlay track the template uses; higher draws on top. */
  lane: number;
  item: TemplateItem;
  /** For an image item: the key of its picture in `images`. */
  image?: string;
}

export interface OverlayTemplate {
  version: 1;
  name: string;
  /** The canvas it was made on, so text sizes can follow a different one. */
  canvas: { width: number; height: number };
  /** Seconds, from the first item's start to the last one's end. */
  duration: number;
  layers: TemplateLayer[];
  /** By name: `img-<hash>.png`. */
  images: Record<string, TemplateImage>;
}

/** The items a template can take from a selection, and what it leaves out. */
export function templateCandidates(edit: Edit, ids: ReadonlySet<string>) {
  const overlay = new Set(edit.tracks.filter((t) => t.kind === "overlay").map((t) => t.id));
  const picked = edit.items.filter((i) => ids.has(i.id));
  const usable = picked.filter(
    (i): i is ImageItem | TextItem => overlay.has(i.trackId) && (i.kind === "text" || i.kind === "image"),
  );
  return { usable, skipped: picked.length - usable.length };
}

/**
 * A template from the selected overlay items. `images` holds each image
 * source's PNG, by source id, already encoded; an image whose picture is
 * missing is left out.
 */
export function templateFrom(
  edit: Edit,
  ids: ReadonlySet<string>,
  name: string,
  images: ReadonlyMap<string, { name: string } & TemplateImage>,
): { template: OverlayTemplate; skipped: number } | null {
  const { usable, skipped } = templateCandidates(edit, ids);
  const items = usable.filter((i) => i.kind === "text" || images.has(i.sourceId));
  if (items.length === 0) return null;

  // Lanes in track order, numbered from the lowest track used.
  const order = new Map(edit.tracks.map((t, i) => [t.id, i]));
  const tracks = [...new Set(items.map((i) => i.trackId))].sort((a, b) => order.get(a)! - order.get(b)!);
  const lane = new Map(tracks.map((id, i) => [id, i]));

  const t0 = Math.min(...items.map((i) => i.start));
  const t1 = Math.max(...items.map((i) => itemEnd(i)));
  const embedded: Record<string, TemplateImage> = {};
  const layers: TemplateLayer[] = items.map((item) => {
    const { id: _id, trackId: _track, ...rest } = item;
    if (item.kind === "image") {
      const picture = images.get(item.sourceId)!;
      embedded[picture.name] = { width: picture.width, height: picture.height, png: picture.png };
      const { sourceId: _source, ...still } = rest as Omit<ImageItem, "id" | "trackId">;
      return { lane: lane.get(item.trackId)!, item: { ...still, start: item.start - t0 }, image: picture.name };
    }
    return { lane: lane.get(item.trackId)!, item: { ...(rest as Omit<TextItem, "id" | "trackId">), start: item.start - t0 } };
  });

  return {
    template: {
      version: 1,
      name: name.trim() || "Template",
      canvas: { width: edit.canvas.width, height: edit.canvas.height },
      duration: t1 - t0,
      layers,
      images: embedded,
    },
    skipped: skipped + (usable.length - items.length),
  };
}

export function serializeTemplate(template: OverlayTemplate): string {
  return JSON.stringify(template);
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function rec(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/** Reads a template file tolerantly; throws when there is nothing usable in it. */
export function parseTemplate(raw: string): OverlayTemplate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("That template file is not valid JSON.");
  }
  const t = rec(parsed);
  if (!t) throw new Error("That template file is empty or malformed.");
  const canvas = rec(t.canvas) ?? {};

  const images: Record<string, TemplateImage> = {};
  for (const [key, value] of Object.entries(rec(t.images) ?? {})) {
    const img = rec(value);
    if (!img || typeof img.png !== "string" || !/^img-[a-z0-9]+\.png$/.test(key)) continue;
    images[key] = { width: Math.max(1, num(img.width, 1)), height: Math.max(1, num(img.height, 1)), png: img.png };
  }

  const layers: TemplateLayer[] = (Array.isArray(t.layers) ? t.layers : []).flatMap((raw): TemplateLayer[] => {
    const l = rec(raw);
    const i = rec(l?.item);
    if (!l || !i) return [];
    const duration = num(i.duration, 0);
    if (!(duration >= MIN_ITEM_SECONDS)) return [];
    const keys = (Array.isArray(i.transform) ? i.transform : [])
      .map(coerceKey)
      .filter((k): k is TransformKey => k !== null)
      .sort((a, b) => a.time - b.time);
    const base = {
      start: Math.max(0, num(i.start, 0)),
      duration,
      fadeIn: Math.max(0, num(i.fadeIn, 0)),
      fadeOut: Math.max(0, num(i.fadeOut, 0)),
      opacity: Math.min(1, Math.max(0, num(i.opacity, 1))),
      transform: keys.length > 0 ? keys : [{ time: 0, x: 0.5, y: 0.5, scale: 1 }],
    };
    const lane = Math.max(0, Math.round(num(l.lane, 0)));
    if (i.kind === "text") {
      return [{ lane, item: { ...base, kind: "text", text: typeof i.text === "string" ? i.text : "", style: coerceStyle(i.style) } }];
    }
    if (i.kind === "image" && typeof l.image === "string" && images[l.image]) {
      return [{ lane, item: { ...base, kind: "image" }, image: l.image }];
    }
    return [];
  });
  if (layers.length === 0) throw new Error("That template has nothing in it to insert.");

  return {
    version: 1,
    name: typeof t.name === "string" && t.name.trim() ? t.name.trim() : "Template",
    canvas: { width: Math.max(2, num(canvas.width, 1920)), height: Math.max(2, num(canvas.height, 1080)) },
    duration: Math.max(...layers.map((l) => l.item.start + l.item.duration)),
    layers,
    images,
  };
}

/** True when nothing on `track` overlaps `[start, end)`. */
function trackFree(edit: Edit, track: EditTrack, start: number, end: number): boolean {
  return !edit.items.some((i) => i.trackId === track.id && i.start < end - 1e-9 && itemEnd(i) > start + 1e-9);
}

/**
 * Places a template at timeline time `at`, its lanes in order on overlay
 * tracks free for its length. Text sizes follow the canvas's height.
 *
 * `imagePaths` says where each embedded image was written.
 */
export function instantiateTemplate(
  edit: Edit,
  template: OverlayTemplate,
  at: number,
  imagePaths: ReadonlyMap<string, string>,
  makeIds: () => string = makeId,
): { edit: Edit; itemIds: string[] } {
  const start = Math.max(0, at);
  const end = start + template.duration;
  let next = edit;

  // A track for each lane, lowest first: the highest overlay tracks free for
  // the template's length, in order, then new tracks on top for any lanes
  // left over. Either way each lane draws above the one before.
  const laneCount = Math.max(...template.layers.map((l) => l.lane)) + 1;
  const free = next.tracks.filter((t) => t.kind === "overlay" && trackFree(next, t, start, end));
  const laneTrack = free.slice(Math.max(0, free.length - laneCount)).map((t) => t.id);
  while (laneTrack.length < laneCount) {
    const added = addOverlayTrack(next, makeIds());
    next = added.edit;
    laneTrack.push(added.id);
  }

  // An image source for each embedded picture that was written out.
  const sourceIds = new Map<string, string>();
  for (const [name, image] of Object.entries(template.images)) {
    const path = imagePaths.get(name);
    if (!path) continue;
    const added = addSource(next, {
      id: makeIds(),
      path,
      kind: "image",
      width: image.width,
      height: image.height,
      duration: 0,
      hasAudio: false,
    });
    next = added.edit;
    sourceIds.set(name, added.id);
  }

  const ratio = edit.canvas.height / template.canvas.height;
  const itemIds: string[] = [];
  const items = template.layers.flatMap((layer): EditItem[] => {
    const common = { id: makeIds(), trackId: laneTrack[layer.lane], start: start + layer.item.start };
    if (layer.item.kind === "text") {
      itemIds.push(common.id);
      const style = ratio === 1 ? layer.item.style : scaleStyle(layer.item.style, ratio);
      return [{ ...layer.item, ...common, style } as TextItem];
    }
    const sourceId = layer.image ? sourceIds.get(layer.image) : undefined;
    if (!sourceId) return [];
    itemIds.push(common.id);
    return [{ ...layer.item, ...common, sourceId } as ImageItem];
  });

  return { edit: { ...next, items: [...next.items, ...items] }, itemIds };
}

// --- Bytes ------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
