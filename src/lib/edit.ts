/**
 * The Edit tab's model: a cut of one or more sources, with everything drawn as
 * a layer over black. Pure functions over `Edit`, so the timeline, the preview
 * and the bake plan all share one set of rules — and the transform maths lives
 * here once, for both the preview and the render plan.
 */

import type {
  Edit,
  EditCanvas,
  EditItem,
  EditSource,
  EditTrack,
  MediaInfo,
  TextItem,
  TextStyle,
  TransformKey,
  VideoItem,
} from "../types";
import { makeId } from "./ids";
import { basename, dbToGain } from "./voiceover";

export const MAIN_TRACK_ID = "main";
/** Shortest an item may be trimmed or split to. */
export const MIN_ITEM_SECONDS = 0.05;
export const DEFAULT_FPS = 30;
export const MIN_FPS = 1;
export const MAX_FPS = 120;
/** Seconds an image or text item lasts when first placed. */
export const DEFAULT_STILL_SECONDS = 3;
/** Codecs the webview can be relied on to play in the preview. */
const PREVIEW_CODECS = new Set(["h264", "vp8", "vp9", "av1"]);

/** libx264 with yuv420p needs even dimensions. */
export function evenDimension(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

export function defaultTransform(): TransformKey[] {
  return [{ time: 0, x: 0.5, y: 0.5, scale: 1 }];
}

export function mainTrack(): EditTrack {
  return { id: MAIN_TRACK_ID, kind: "main", name: "Main", hidden: false, muted: false };
}

export function canvasFor(info: { width: number; height: number; fps?: number }): EditCanvas {
  const fps = info.fps && Number.isFinite(info.fps) ? info.fps : DEFAULT_FPS;
  return {
    width: evenDimension(info.width || 1920),
    height: evenDimension(info.height || 1080),
    fps: Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(fps * 1000) / 1000)),
  };
}

export function sourceFromInfo(path: string, info: MediaInfo, kind: EditSource["kind"]): EditSource {
  return {
    id: makeId(),
    path,
    kind,
    width: info.width,
    height: info.height,
    duration: kind === "image" ? 0 : info.duration,
    ...(kind === "video" ? { fps: info.fps } : {}),
    hasAudio: kind === "video" && info.hasAudio,
    ...(info.videoCodec ? { videoCodec: info.videoCodec } : {}),
  };
}

/** True when the preview probably cannot play this source. */
export function previewUnsupported(source: EditSource): boolean {
  return (
    source.kind === "video" &&
    source.videoCodec !== undefined &&
    !PREVIEW_CODECS.has(source.videoCodec.toLowerCase())
  );
}

export function sourceName(source: EditSource): string {
  return basename(source.path);
}

/** An edit with one source, cut as a whole onto the main track. */
export function startEditFromVideo(path: string, info: MediaInfo): Edit {
  const source = sourceFromInfo(path, info, "video");
  const edit: Edit = {
    canvas: canvasFor(info),
    sources: [source],
    tracks: [mainTrack()],
    items: [],
  };
  return placeSource(edit, source.id, MAIN_TRACK_ID, 0).edit;
}

/** Adds a source, or finds the one already there for the same file. */
export function addSource(edit: Edit, source: EditSource): { edit: Edit; id: string } {
  const existing = edit.sources.find((s) => s.path === source.path);
  if (existing) return { edit, id: existing.id };
  return { edit: { ...edit, sources: [...edit.sources, source] }, id: source.id };
}

/** Removes a source and every item drawn from it. */
export function removeSource(edit: Edit, id: string): Edit {
  if (!edit.sources.some((s) => s.id === id)) return edit;
  return {
    ...edit,
    sources: edit.sources.filter((s) => s.id !== id),
    items: edit.items.filter((i) => !("sourceId" in i) || i.sourceId !== id),
  };
}

export function sourceOf(edit: Edit, item: EditItem): EditSource | undefined {
  return item.kind === "text" ? undefined : edit.sources.find((s) => s.id === item.sourceId);
}

export function trackOf(edit: Edit, item: EditItem): EditTrack | undefined {
  return edit.tracks.find((t) => t.id === item.trackId);
}

export function itemEnd(item: EditItem): number {
  return item.start + item.duration;
}

/** The timeline ends at the last item on any track. */
export function editEnd(edit: Edit): number {
  return edit.items.reduce((end, item) => Math.max(end, itemEnd(item)), 0);
}

function isMain(edit: Edit, trackId: string): boolean {
  return edit.tracks.find((t) => t.id === trackId)?.kind === "main";
}

/** Items on a track, in time order. */
export function trackItems(edit: Edit, trackId: string): EditItem[] {
  return edit.items.filter((i) => i.trackId === trackId).sort((a, b) => a.start - b.start);
}

/**
 * The start nearest `start` at which an item of `duration` fits on the track.
 * Main-track items may not overlap, so this looks for the closest gap wide
 * enough; overlay tracks take any start at or after zero.
 */
export function freeStart(
  edit: Edit,
  trackId: string,
  start: number,
  duration: number,
  ignoreId?: string,
): number {
  const wanted = Math.max(0, start);
  if (!isMain(edit, trackId)) return wanted;
  const others = trackItems(edit, trackId).filter((i) => i.id !== ignoreId);
  let best = Number.NaN;
  let bestDistance = Infinity;
  let gapStart = 0;
  const consider = (gapEnd: number) => {
    if (gapEnd - gapStart + 1e-9 < duration) return;
    const candidate = Math.min(Math.max(wanted, gapStart), gapEnd - duration);
    const distance = Math.abs(candidate - wanted);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  };
  for (const other of others) {
    consider(other.start);
    gapStart = Math.max(gapStart, itemEnd(other));
  }
  consider(Infinity);
  return best;
}

/** Ids of main-track items that overlap another. Should always be empty. */
export function mainTrackOverlaps(edit: Edit): Set<string> {
  const found = new Set<string>();
  for (const track of edit.tracks) {
    if (track.kind !== "main") continue;
    const items = trackItems(edit, track.id);
    for (let i = 1; i < items.length; i++) {
      if (items[i].start < itemEnd(items[i - 1]) - 1e-9) {
        found.add(items[i - 1].id);
        found.add(items[i].id);
      }
    }
  }
  return found;
}

/** Keeps the fades inside the item: fadeIn first, fadeOut takes what is left. */
function clampFades<T extends EditItem>(item: T): T {
  const fadeIn = Math.min(Math.max(0, item.fadeIn), item.duration);
  const fadeOut = Math.min(Math.max(0, item.fadeOut), item.duration - fadeIn);
  return fadeIn === item.fadeIn && fadeOut === item.fadeOut ? item : { ...item, fadeIn, fadeOut };
}

/** Applies `fn` to one item; returns the same edit when nothing changed. */
function mapItem(edit: Edit, id: string, fn: (item: EditItem) => EditItem): Edit {
  let changed = false;
  const items = edit.items.map((item) => {
    if (item.id !== id) return item;
    const next = fn(item);
    if (next === item) return item;
    changed = (Object.keys(next) as Array<keyof EditItem>).some((k) => next[k] !== item[k]);
    return changed ? next : item;
  });
  return changed ? { ...edit, items } : edit;
}

function baseItem(trackId: string, start: number, duration: number, id = makeId()) {
  return {
    id,
    trackId,
    start,
    duration,
    fadeIn: 0,
    fadeOut: 0,
    opacity: 1,
    transform: defaultTransform(),
  };
}

/**
 * Places a whole source on a track near `start`: a video for its full length,
 * an image for a few seconds.
 */
export function placeSource(
  edit: Edit,
  sourceId: string,
  trackId: string,
  start: number,
  newId = makeId(),
): { edit: Edit; id: string | null } {
  const source = edit.sources.find((s) => s.id === sourceId);
  if (!source || !edit.tracks.some((t) => t.id === trackId)) return { edit, id: null };
  const duration = source.kind === "video" ? source.duration : DEFAULT_STILL_SECONDS;
  if (!(duration >= MIN_ITEM_SECONDS)) return { edit, id: null };
  const at = freeStart(edit, trackId, start, duration);
  const item: EditItem =
    source.kind === "video"
      ? { ...baseItem(trackId, at, duration, newId), kind: "video", sourceId, offset: 0, gainDb: 0 }
      : { ...baseItem(trackId, at, duration, newId), kind: "image", sourceId };
  return { edit: { ...edit, items: [...edit.items, item] }, id: item.id };
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: "Arial",
  fontSize: 72,
  color: "#ffffff",
  weight: 700,
  align: "center",
  outline: { color: "#000000", width: 4 },
};

/** A text item at `start` on an overlay track. Text never goes on the main track. */
export function placeText(
  edit: Edit,
  trackId: string,
  start: number,
  text = "Text",
  newId = makeId(),
): { edit: Edit; id: string | null } {
  if (edit.tracks.find((t) => t.id === trackId)?.kind !== "overlay") return { edit, id: null };
  const at = freeStart(edit, trackId, start, DEFAULT_STILL_SECONDS);
  const item: TextItem = {
    ...baseItem(trackId, at, DEFAULT_STILL_SECONDS, newId),
    kind: "text",
    text,
    style: { ...DEFAULT_TEXT_STYLE },
  };
  return { edit: { ...edit, items: [...edit.items, item] }, id: item.id };
}

/**
 * Moves an item in time and, optionally, onto another track. The main track
 * takes video and images; text stays on the overlays.
 */
export function moveItem(edit: Edit, id: string, start: number, trackId?: string): Edit {
  const item = edit.items.find((i) => i.id === id);
  if (!item) return edit;
  const wanted = trackId === undefined ? undefined : edit.tracks.find((t) => t.id === trackId);
  const allowed = wanted && !(wanted.kind === "main" && item.kind === "text");
  const target = allowed ? wanted.id : item.trackId;
  const at = freeStart(edit, target, start, item.duration, id);
  return mapItem(edit, id, (i) => ({ ...i, start: at, trackId: target }));
}

/** Neighbouring main-track items bound a trim; overlay items are unbounded. */
function neighbours(edit: Edit, item: EditItem): { before: number; after: number } {
  if (!isMain(edit, item.trackId)) return { before: 0, after: Infinity };
  let before = 0;
  let after = Infinity;
  for (const other of edit.items) {
    if (other.id === item.id || other.trackId !== item.trackId) continue;
    if (itemEnd(other) <= item.start + 1e-9) before = Math.max(before, itemEnd(other));
    else if (other.start >= itemEnd(item) - 1e-9) after = Math.min(after, other.start);
  }
  return { before, after };
}

/**
 * Moves the item's head to `start` while its tail stays put. A video item
 * reveals or hides the start of its source, and cannot reach before it.
 */
export function trimItemStart(edit: Edit, id: string, start: number): Edit {
  const item = edit.items.find((i) => i.id === id);
  if (!item) return edit;
  const { before } = neighbours(edit, item);
  const end = itemEnd(item);
  let earliest = before;
  if (item.kind === "video") earliest = Math.max(earliest, item.start - item.offset);
  const next = Math.min(end - MIN_ITEM_SECONDS, Math.max(earliest, start));
  const shift = next - item.start;
  return mapItem(edit, id, (i) =>
    clampFades({
      ...i,
      start: next,
      duration: i.duration - shift,
      transform: shiftKeys(i.transform, shift),
      ...(i.kind === "video" ? { offset: i.offset + shift } : {}),
    } as EditItem),
  );
}

/** Moves the item's tail to `end`; a video item cannot run past its source. */
export function trimItemEnd(edit: Edit, id: string, end: number): Edit {
  const item = edit.items.find((i) => i.id === id);
  if (!item) return edit;
  const { after } = neighbours(edit, item);
  let latest = after;
  if (item.kind === "video") {
    const source = sourceOf(edit, item);
    if (source) latest = Math.min(latest, item.start + source.duration - item.offset);
  }
  const nextEnd = Math.max(item.start + MIN_ITEM_SECONDS, Math.min(latest, end));
  return mapItem(edit, id, (i) => clampFades({ ...i, duration: nextEnd - i.start }));
}

/**
 * Cuts an item in two at timeline time `t`. Fades stay on the outer ends; the
 * motion carries on across the cut.
 */
export function splitItem(
  edit: Edit,
  id: string,
  t: number,
  newId = makeId(),
): { edit: Edit; id: string | null } {
  const item = edit.items.find((i) => i.id === id);
  if (!item) return { edit, id: null };
  const cut = t - item.start;
  if (cut < MIN_ITEM_SECONDS || item.duration - cut < MIN_ITEM_SECONDS) return { edit, id: null };
  const { left: leftKeys, right: rightKeys } = splitKeys(item.transform, cut);
  const left = clampFades({ ...item, duration: cut, fadeOut: 0, transform: leftKeys } as EditItem);
  const right = clampFades({
    ...item,
    id: newId,
    start: t,
    duration: item.duration - cut,
    fadeIn: 0,
    transform: rightKeys,
    ...(item.kind === "video" ? { offset: (item as VideoItem).offset + cut } : {}),
  } as EditItem);
  const items = edit.items.flatMap((i) => (i.id === id ? [left, right] : [i]));
  return { edit: { ...edit, items }, id: right.id };
}

function splitKeys(keys: TransformKey[], cut: number): { left: TransformKey[]; right: TransformKey[] } {
  if (keys.length <= 1) return { left: keys, right: keys };
  const at = transformAt(keys, cut);
  const left = keys.filter((k) => k.time < cut);
  const right = keys.filter((k) => k.time > cut).map((k) => ({ ...k, time: k.time - cut }));
  return {
    left: [...left, { ...at, time: cut }],
    right: [{ ...at, time: 0 }, ...right],
  };
}

export function removeItem(edit: Edit, id: string): Edit {
  return edit.items.some((i) => i.id === id)
    ? { ...edit, items: edit.items.filter((i) => i.id !== id) }
    : edit;
}

/** Fields the inspector may change directly. */
export type ItemPatch = Partial<
  Pick<EditItem, "fadeIn" | "fadeOut" | "opacity" | "transform"> &
    Pick<VideoItem, "gainDb"> &
    Pick<TextItem, "text" | "style">
>;

export function patchItem(edit: Edit, id: string, patch: ItemPatch): Edit {
  return mapItem(edit, id, (item) => {
    const next = { ...item } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if ((key === "gainDb" && item.kind !== "video") || ((key === "text" || key === "style") && item.kind !== "text")) {
        continue;
      }
      next[key] = value;
    }
    const merged = next as unknown as EditItem;
    return clampFades({
      ...merged,
      opacity: Math.min(1, Math.max(0, merged.opacity)),
      transform: merged.transform.length > 0 ? merged.transform : item.transform,
    });
  });
}

/** Sets one fade; the other is left alone, and this one gives way to it. */
export function setFade(edit: Edit, id: string, edge: "in" | "out", seconds: number): Edit {
  return mapItem(edit, id, (item) => {
    const room = item.duration - (edge === "in" ? item.fadeOut : item.fadeIn);
    const value = Math.min(Math.max(0, seconds), room);
    return edge === "in" ? { ...item, fadeIn: value } : { ...item, fadeOut: value };
  });
}

export function patchTrack(edit: Edit, id: string, patch: Partial<Pick<EditTrack, "name" | "hidden" | "muted">>): Edit {
  let changed = false;
  const tracks = edit.tracks.map((t) => {
    if (t.id !== id) return t;
    const next = { ...t, ...patch };
    changed = next.name !== t.name || next.hidden !== t.hidden || next.muted !== t.muted;
    return changed ? next : t;
  });
  return changed ? { ...edit, tracks } : edit;
}

/** Adds an overlay track on top of the others. */
export function addOverlayTrack(edit: Edit, id = makeId()): { edit: Edit; id: string } {
  const count = edit.tracks.filter((t) => t.kind === "overlay").length;
  const track: EditTrack = {
    id,
    kind: "overlay",
    name: `Overlay ${count + 1}`,
    hidden: false,
    muted: false,
  };
  return { edit: { ...edit, tracks: [...edit.tracks, track] }, id: track.id };
}

/**
 * The overlay track a new still or text goes on: the topmost one that is free
 * from `start` for `duration`, or a new track on top when none is — so two
 * things placed at the same moment never share a lane.
 */
export function overlayTarget(
  edit: Edit,
  start: number,
  duration: number,
  newId = makeId(),
): { edit: Edit; trackId: string } {
  const end = start + duration;
  const free = [...edit.tracks]
    .reverse()
    .find(
      (t) =>
        t.kind === "overlay" &&
        !edit.items.some((i) => i.trackId === t.id && i.start < end - 1e-9 && itemEnd(i) > start + 1e-9),
    );
  if (free) return { edit, trackId: free.id };
  const added = addOverlayTrack(edit, newId);
  return { edit: added.edit, trackId: added.id };
}

/**
 * Moves an overlay track one place up (+1, drawn above more) or down (-1).
 * The main track stays at the bottom.
 */
export function moveTrack(edit: Edit, id: string, direction: number): Edit {
  const index = edit.tracks.findIndex((t) => t.id === id);
  const target = index + Math.sign(direction);
  if (index < 1 || target < 1 || target >= edit.tracks.length || target === index) return edit;
  const tracks = [...edit.tracks];
  [tracks[index], tracks[target]] = [tracks[target], tracks[index]];
  return { ...edit, tracks };
}

export const MIN_SCALE = 0.01;
export const MAX_SCALE = 20;

// --- Keys -----------------------------------------------------------------------

/** How near a time must be to a key to be on it, when the caller does not say. */
export const KEY_TOLERANCE = 0.01;

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** The key within `tolerance` of `t` (item-local seconds), or -1. */
export function keyIndexAt(keys: TransformKey[], t: number, tolerance = KEY_TOLERANCE): number {
  let best = -1;
  let bestDistance = tolerance;
  keys.forEach((key, i) => {
    const distance = Math.abs(key.time - t);
    if (distance <= bestDistance) {
      best = i;
      bestDistance = distance;
    }
  });
  return best;
}

/** True when the item moves: it has more than one key. */
export function isAnimated(item: EditItem): boolean {
  return item.transform.length > 1;
}

function withKeys(item: EditItem, keys: TransformKey[]): EditItem {
  return { ...item, transform: [...keys].sort((a, b) => a.time - b.time) };
}

/**
 * Adds a key at `t` holding the item's place there, so nothing moves until it
 * is changed. A static item's one key stays where it is, and the item becomes
 * animated. Asked for on a still item's own key — at its start, usually — the
 * new key goes at the item's end instead: the obvious way to start a move.
 */
export function addKey(edit: Edit, id: string, t: number, tolerance = KEY_TOLERANCE): Edit {
  return mapItem(edit, id, (item) => {
    if (t < -1e-9 || t > item.duration + 1e-9) return item;
    if (keyIndexAt(item.transform, t, tolerance) >= 0) {
      const only = item.transform.length === 1 ? item.transform[0] : null;
      if (!only || item.duration - only.time <= tolerance) return item;
      return withKeys(item, [only, { ...only, time: item.duration }]);
    }
    const at = Math.min(item.duration, Math.max(0, t));
    return withKeys(item, [...item.transform, { ...transformAt(item.transform, at), time: at }]);
  });
}

/** Removes one key; the last key always stays. */
export function removeKey(edit: Edit, id: string, index: number): Edit {
  return mapItem(edit, id, (item) => {
    if (item.transform.length <= 1 || index < 0 || index >= item.transform.length) return item;
    return { ...item, transform: item.transform.filter((_, i) => i !== index) };
  });
}

/** The smallest gap kept between keys, so a drag never swaps their order. */
const KEY_GAP = 0.001;

/** Moves a key in time, between its neighbours and inside the item. */
export function moveKey(edit: Edit, id: string, index: number, t: number): Edit {
  return mapItem(edit, id, (item) => {
    const keys = item.transform;
    if (index < 0 || index >= keys.length) return item;
    const lo = index > 0 ? keys[index - 1].time + KEY_GAP : 0;
    const hi = index < keys.length - 1 ? keys[index + 1].time - KEY_GAP : item.duration;
    if (lo > hi) return item;
    const time = Math.min(hi, Math.max(lo, t));
    if (time === keys[index].time) return item;
    return { ...item, transform: keys.map((k, i) => (i === index ? { ...k, time } : k)) };
  });
}

/**
 * Changes the item's place or size at `t`. A static item is changed as a
 * whole. An animated one has the key at `t` changed, or gains one there: a
 * change at a moment the item moves through is a new key.
 */
export function setTransformAt(
  edit: Edit,
  id: string,
  t: number,
  patch: Partial<Omit<TransformKey, "time">>,
  tolerance = KEY_TOLERANCE,
): Edit {
  return mapItem(edit, id, (item) => {
    const keys = item.transform;
    const apply = (key: TransformKey): TransformKey => ({
      time: key.time,
      x: Number.isFinite(patch.x) ? patch.x! : key.x,
      y: Number.isFinite(patch.y) ? patch.y! : key.y,
      scale: Number.isFinite(patch.scale) ? clampScale(patch.scale!) : key.scale,
    });
    const same = (a: TransformKey, b: TransformKey) => a.x === b.x && a.y === b.y && a.scale === b.scale;
    if (keys.length === 1) {
      const next = apply(keys[0]);
      return same(next, keys[0]) ? item : { ...item, transform: [next] };
    }
    const index = keyIndexAt(keys, t, tolerance);
    if (index >= 0) {
      const next = apply(keys[index]);
      return same(next, keys[index]) ? item : { ...item, transform: keys.map((k, i) => (i === index ? next : k)) };
    }
    if (t < 0 || t > item.duration) return item;
    const here = { ...transformAt(keys, t), time: t };
    const next = apply(here);
    return same(next, here) ? item : withKeys(item, [...keys, next]);
  });
}

/** Stops the item moving: it keeps where it is at `t`, as its only key. */
export function clearMotion(edit: Edit, id: string, t: number): Edit {
  return mapItem(edit, id, (item) => {
    if (item.transform.length <= 1) return item;
    const at = Math.min(item.duration, Math.max(0, t));
    return { ...item, transform: [{ ...transformAt(item.transform, at), time: 0 }] };
  });
}

/**
 * Keys after the item's head moved by `shift` seconds, kept on the same
 * moments of the picture. A head trimmed past keys samples where the motion
 * had got to, so what is left moves as it did.
 */
export function shiftKeys(keys: TransformKey[], shift: number): TransformKey[] {
  if (keys.length <= 1 || shift === 0) return keys;
  const moved = keys.map((k) => ({ ...k, time: k.time - shift }));
  const kept = moved.filter((k) => k.time >= 0);
  if (kept.length === moved.length) return moved;
  const head = { ...transformAt(keys, shift), time: 0 };
  return kept.length > 0 && kept[0].time < KEY_GAP ? kept : [head, ...kept];
}

/** Changes a text item's words. */
export function setText(edit: Edit, id: string, text: string): Edit {
  return mapItem(edit, id, (item) =>
    item.kind === "text" && item.text !== text ? { ...item, text } : item,
  );
}

/**
 * Changes a text item's look. `null` for outline, shadow or background takes
 * that effect away; an object replaces it whole.
 */
export function patchTextStyle(
  edit: Edit,
  id: string,
  patch: Partial<Omit<TextStyle, "outline" | "shadow" | "background">> & {
    outline?: TextStyle["outline"] | null;
    shadow?: TextStyle["shadow"] | null;
    background?: TextStyle["background"] | null;
  },
): Edit {
  return mapItem(edit, id, (item) => {
    if (item.kind !== "text") return item;
    const style: TextStyle = { ...item.style };
    for (const [key, value] of Object.entries(patch) as Array<[keyof TextStyle, unknown]>) {
      if (value === undefined) continue;
      if (value === null) delete style[key];
      else (style as unknown as Record<string, unknown>)[key] = value;
    }
    style.fontSize = Math.max(1, style.fontSize);
    return { ...item, style };
  });
}

/** Removes an overlay track and its items. The main track stays. */
export function removeTrack(edit: Edit, id: string): Edit {
  const track = edit.tracks.find((t) => t.id === id);
  if (!track || track.kind === "main") return edit;
  return {
    ...edit,
    tracks: edit.tracks.filter((t) => t.id !== id),
    items: edit.items.filter((i) => i.trackId !== id),
  };
}

/**
 * Changes the canvas. Positions are fractions and survive as they are; text
 * sizes are pixels, so they scale with the height to keep the same look.
 */
export function setCanvas(edit: Edit, canvas: EditCanvas): Edit {
  const next: EditCanvas = {
    width: evenDimension(canvas.width),
    height: evenDimension(canvas.height),
    fps: Math.min(MAX_FPS, Math.max(MIN_FPS, canvas.fps)),
  };
  const same =
    next.width === edit.canvas.width &&
    next.height === edit.canvas.height &&
    next.fps === edit.canvas.fps;
  if (same) return edit;
  const ratio = next.height / edit.canvas.height;
  const items =
    ratio === 1
      ? edit.items
      : edit.items.map((item) =>
          item.kind === "text" ? { ...item, style: scaleStyle(item.style, ratio) } : item,
        );
  return { ...edit, canvas: next, items };
}

export function scaleStyle(style: TextStyle, ratio: number): TextStyle {
  const px = (n: number) => Math.round(n * ratio * 100) / 100;
  return {
    ...style,
    fontSize: px(style.fontSize),
    ...(style.outline ? { outline: { ...style.outline, width: px(style.outline.width) } } : {}),
    ...(style.shadow
      ? {
          shadow: {
            ...style.shadow,
            blur: px(style.shadow.blur),
            dx: px(style.shadow.dx),
            dy: px(style.shadow.dy),
          },
        }
      : {}),
    ...(style.background
      ? { background: { ...style.background, padding: px(style.background.padding) } }
      : {}),
  };
}

// --- Drawing -------------------------------------------------------------------

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The item's size at `scale = 1`, in canvas pixels. Video and images fit
 * inside the canvas, keeping their aspect; text is its drawn size.
 */
export function naturalSize(
  item: EditItem,
  canvas: EditCanvas,
  source: EditSource | undefined,
  textSize?: Size,
): Size | null {
  if (item.kind === "text") return textSize ?? null;
  if (!source || !(source.width > 0) || !(source.height > 0)) return null;
  const fit = Math.min(canvas.width / source.width, canvas.height / source.height);
  return { width: source.width * fit, height: source.height * fit };
}

/** The transform at `t` seconds into the item: linear between keys, held outside. */
export function transformAt(keys: TransformKey[], t: number): TransformKey {
  if (keys.length === 0) return { ...defaultTransform()[0], time: t };
  const sorted = keys.length > 1 ? [...keys].sort((a, b) => a.time - b.time) : keys;
  if (t <= sorted[0].time) return { ...sorted[0], time: t };
  const last = sorted[sorted.length - 1];
  if (t >= last.time) return { ...last, time: t };
  for (let i = 1; i < sorted.length; i++) {
    const b = sorted[i];
    if (t > b.time) continue;
    const a = sorted[i - 1];
    const span = b.time - a.time;
    const f = span > 0 ? (t - a.time) / span : 1;
    return {
      time: t,
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      scale: a.scale + (b.scale - a.scale) * f,
    };
  }
  return { ...last, time: t };
}

/** Where a key puts an item of `natural` size, in whole canvas pixels. */
export function resolveRect(natural: Size, key: TransformKey, canvas: EditCanvas): Rect {
  const w = Math.max(1, Math.round(natural.width * key.scale));
  const h = Math.max(1, Math.round(natural.height * key.scale));
  return {
    x: Math.round(key.x * canvas.width - w / 2),
    y: Math.round(key.y * canvas.height - h / 2),
    w,
    h,
  };
}

/**
 * The same, unrounded: for items that move, whose place must change smoothly
 * from frame to frame rather than in whole pixels.
 */
export function resolveRectExact(natural: Size, key: TransformKey, canvas: EditCanvas): Rect {
  const w = Math.max(1, natural.width * key.scale);
  const h = Math.max(1, natural.height * key.scale);
  return { x: key.x * canvas.width - w / 2, y: key.y * canvas.height - h / 2, w, h };
}

/** Where an item is drawn at `t` seconds into it: whole pixels when still, exact when moving. */
export function placeAt(item: EditItem, natural: Size, t: number, canvas: EditCanvas): Rect {
  const key = transformAt(item.transform, t);
  return isAnimated(item) ? resolveRectExact(natural, key, canvas) : resolveRect(natural, key, canvas);
}

/** 0..1 ramp from the fades, at `t` seconds into the item; 0 outside it. */
function ramp(item: EditItem, t: number): number {
  if (t < 0 || t > item.duration) return 0;
  let level = 1;
  if (item.fadeIn > 0) level = Math.min(level, t / item.fadeIn);
  if (item.fadeOut > 0) level = Math.min(level, (item.duration - t) / item.fadeOut);
  return Math.min(1, Math.max(0, level));
}

/** The item's alpha at `t` seconds into it. */
export function alphaAt(item: EditItem, t: number): number {
  return ramp(item, t) * item.opacity;
}

/** The linear audio gain of a video item at `t` seconds into it. */
export function audioGainAt(item: EditItem, t: number): number {
  if (item.kind !== "video") return 0;
  return ramp(item, t) * dbToGain(item.gainDb);
}

/** Items showing at timeline time `t`, bottom layer first. Hidden tracks are skipped. */
export function itemsAt(edit: Edit, t: number): EditItem[] {
  const out: EditItem[] = [];
  for (const track of edit.tracks) {
    if (track.hidden) continue;
    for (const item of trackItems(edit, track.id)) {
      if (t >= item.start && t < itemEnd(item)) out.push(item);
    }
  }
  return out;
}

/** The main-track video item that starts next after `t`, for preloading. */
export function nextMainItem(edit: Edit, t: number): EditItem | undefined {
  const main = edit.tracks.find((tr) => tr.kind === "main");
  if (!main) return undefined;
  return trackItems(edit, main.id).find((i) => i.start > t);
}

// --- Reading from a project file ------------------------------------------------

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function record(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function coerceSource(raw: unknown): EditSource | null {
  const s = record(raw);
  if (!s) return null;
  const path = str(s.path);
  if (!path || (s.kind !== "video" && s.kind !== "image")) return null;
  return {
    id: str(s.id) || makeId(),
    path,
    kind: s.kind,
    width: Math.max(0, finite(s.width, 0)),
    height: Math.max(0, finite(s.height, 0)),
    duration: s.kind === "image" ? 0 : Math.max(0, finite(s.duration, 0)),
    ...(typeof s.fps === "number" && s.fps > 0 ? { fps: s.fps } : {}),
    hasAudio: s.kind === "video" && s.hasAudio === true,
    ...(str(s.videoCodec) ? { videoCodec: str(s.videoCodec) } : {}),
  };
}

function coerceTrack(raw: unknown): EditTrack | null {
  const t = record(raw);
  if (!t || (t.kind !== "main" && t.kind !== "overlay")) return null;
  return {
    id: t.kind === "main" ? MAIN_TRACK_ID : str(t.id) || makeId(),
    kind: t.kind,
    name: str(t.name) ?? (t.kind === "main" ? "Main" : "Overlay"),
    hidden: t.hidden === true,
    muted: t.muted === true,
  };
}

function coerceKey(raw: unknown): TransformKey | null {
  const k = record(raw);
  if (!k) return null;
  const scale = finite(k.scale, 1);
  return {
    time: Math.max(0, finite(k.time, 0)),
    x: finite(k.x, 0.5),
    y: finite(k.y, 0.5),
    scale: scale > 0 ? scale : 1,
  };
}

function coerceStyle(raw: unknown): TextStyle {
  const s = record(raw) ?? {};
  const outline = record(s.outline);
  const shadow = record(s.shadow);
  const background = record(s.background);
  const align = s.align === "left" || s.align === "right" ? s.align : "center";
  return {
    fontFamily: str(s.fontFamily) || DEFAULT_TEXT_STYLE.fontFamily,
    fontSize: Math.max(1, finite(s.fontSize, DEFAULT_TEXT_STYLE.fontSize)),
    color: str(s.color) || DEFAULT_TEXT_STYLE.color,
    weight: finite(s.weight, DEFAULT_TEXT_STYLE.weight),
    align,
    ...(outline
      ? { outline: { color: str(outline.color) || "#000000", width: Math.max(0, finite(outline.width, 0)) } }
      : {}),
    ...(shadow
      ? {
          shadow: {
            color: str(shadow.color) || "#000000",
            blur: Math.max(0, finite(shadow.blur, 0)),
            dx: finite(shadow.dx, 0),
            dy: finite(shadow.dy, 0),
          },
        }
      : {}),
    ...(background
      ? {
          background: {
            color: str(background.color) || "#000000",
            padding: Math.max(0, finite(background.padding, 0)),
          },
        }
      : {}),
  };
}

function coerceItem(raw: unknown, sources: Map<string, EditSource>, tracks: Set<string>): EditItem | null {
  const i = record(raw);
  if (!i) return null;
  const trackId = str(i.trackId);
  if (!trackId || !tracks.has(trackId)) return null;
  const duration = finite(i.duration, 0);
  if (!(duration >= MIN_ITEM_SECONDS)) return null;
  const keys = Array.isArray(i.transform)
    ? i.transform.map(coerceKey).filter((k): k is TransformKey => k !== null)
    : [];
  const base = {
    id: str(i.id) || makeId(),
    trackId,
    start: Math.max(0, finite(i.start, 0)),
    duration,
    fadeIn: Math.max(0, finite(i.fadeIn, 0)),
    fadeOut: Math.max(0, finite(i.fadeOut, 0)),
    opacity: Math.min(1, Math.max(0, finite(i.opacity, 1))),
    transform: keys.length > 0 ? keys.sort((a, b) => a.time - b.time) : defaultTransform(),
  };
  if (i.kind === "text") {
    return clampFades({ ...base, kind: "text", text: str(i.text) ?? "", style: coerceStyle(i.style) });
  }
  const sourceId = str(i.sourceId);
  const source = sourceId ? sources.get(sourceId) : undefined;
  if (!source) return null;
  if (i.kind === "image" && source.kind === "image") {
    return clampFades({ ...base, kind: "image", sourceId: source.id });
  }
  if (i.kind === "video" && source.kind === "video") {
    const offset = Math.max(0, finite(i.offset, 0));
    const room = source.duration > 0 ? source.duration - offset : duration;
    if (!(room >= MIN_ITEM_SECONDS)) return null;
    return clampFades({
      ...base,
      duration: Math.min(duration, room),
      kind: "video",
      sourceId: source.id,
      offset,
      gainDb: finite(i.gainDb, 0),
    });
  }
  return null;
}

/**
 * Reads the `edit` field of a project file tolerantly. Anything that is not an
 * edit stays absent, so a project without one never grows an empty edit.
 */
export function coerceEdit(raw: unknown): Edit | undefined {
  const e = record(raw);
  if (!e) return undefined;
  const canvasRaw = record(e.canvas) ?? {};
  const canvas = canvasFor({
    width: finite(canvasRaw.width, 1920),
    height: finite(canvasRaw.height, 1080),
    fps: finite(canvasRaw.fps, DEFAULT_FPS),
  });

  const sources = (Array.isArray(e.sources) ? e.sources : [])
    .map(coerceSource)
    .filter((s): s is EditSource => s !== null);
  const sourceMap = new Map(sources.map((s) => [s.id, s]));

  // Exactly one main track, always first.
  const parsedTracks = (Array.isArray(e.tracks) ? e.tracks : [])
    .map(coerceTrack)
    .filter((t): t is EditTrack => t !== null);
  const main = parsedTracks.find((t) => t.kind === "main") ?? mainTrack();
  const tracks = [main, ...parsedTracks.filter((t) => t.kind === "overlay")];
  const trackIds = new Set(tracks.map((t) => t.id));

  const items = (Array.isArray(e.items) ? e.items : [])
    .map((i) => coerceItem(i, sourceMap, trackIds))
    .filter((i): i is EditItem => i !== null);

  const bakedRaw = record(e.baked);
  const bakedPath = bakedRaw ? str(bakedRaw.path) : undefined;
  const baked =
    bakedRaw && bakedPath
      ? { path: bakedPath, planHash: str(bakedRaw.planHash) ?? "", at: str(bakedRaw.at) ?? "" }
      : undefined;

  return { canvas, sources, tracks, items, ...(baked ? { baked } : {}) };
}
