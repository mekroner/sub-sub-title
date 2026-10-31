import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject, PointerEvent as ReactPointerEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Edit, EditItem } from "../../types";
import {
  alphaAt,
  audioGainAt,
  itemsAt,
  naturalSize,
  nextMainItem,
  placeAt,
  sourceOf,
  trackOf,
  transformAt,
  type Rect,
  type Size,
} from "../../lib/edit";
import { assignSlots, type PoolSlot, type PoolWant } from "../../lib/videoPool";

/** Seconds before a main-track clip starts that its element is loaded and seeked. */
const PRELOAD_SECONDS = 2;
/** While playing, an element this far off the clock is re-seeked; nearer, left alone. */
const PLAY_DRIFT = 0.1;

interface Props {
  edit: Edit;
  time: number;
  playing: boolean;
  /** Filled in with a live check: is a visible clip still seeking? The clock waits for it. */
  stalled: MutableRefObject<() => boolean>;
  /** Drawn text, by item id: an image URL and its size in canvas pixels. */
  textImages?: ReadonlyMap<string, { url: string; width: number; height: number }>;
  /** Outlined on the stage, and draggable when it is static. */
  selectedId?: string | null;
  /** Moves the selected item's centre to (x, y), as fractions of the canvas. */
  onMoveSelected?: (id: string, x: number, y: number, drag: string) => void;
}

interface Layer {
  item: EditItem;
  rect: Rect;
  alpha: number;
  z: number;
}

/**
 * The Edit tab's picture: a canvas-sized black stage, letterboxed into the
 * pane, with one element per item showing at the playhead. Placement comes
 * from the same functions the bake plan uses, in canvas pixels, and the stage
 * is scaled as a whole — so what is drawn here is where the bake puts it.
 */
export function EditPreview({
  edit,
  time,
  playing,
  stalled,
  textImages,
  selectedId,
  onMoveSelected,
}: Props) {
  const { canvas } = edit;
  const paneRef = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const measure = () => setPane({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const scale =
    pane.width > 0 && pane.height > 0
      ? Math.min(pane.width / canvas.width, pane.height / canvas.height)
      : 0;

  // What shows now, bottom first, with where and how strongly.
  const layers = useMemo(() => {
    const out: Layer[] = [];
    itemsAt(edit, time).forEach((item, z) => {
      const local = time - item.start;
      const text = item.kind === "text" ? textImages?.get(item.id) : undefined;
      const textSize: Size | undefined = text ? { width: text.width, height: text.height } : undefined;
      const natural = naturalSize(item, canvas, sourceOf(edit, item), textSize);
      if (!natural) return;
      // Whole pixels when still, exact when moving: as the bake draws it.
      const rect = placeAt(item, natural, local, canvas);
      out.push({ item, rect, alpha: alphaAt(item, local), z });
    });
    return out;
  }, [edit, time, canvas, textImages]);

  // Which elements the video items need: the visible ones, then the next
  // main-track clip once it is close.
  const wanted = useMemo(() => {
    const list: PoolWant[] = [];
    for (const { item } of layers) {
      const source = sourceOf(edit, item);
      if (item.kind === "video" && source) list.push({ itemId: item.id, path: source.path });
    }
    const next = nextMainItem(edit, time);
    const nextSource = next ? sourceOf(edit, next) : undefined;
    if (next?.kind === "video" && nextSource && next.start - time <= PRELOAD_SECONDS) {
      list.push({ itemId: next.id, path: nextSource.path });
    }
    return list;
  }, [layers, edit, time]);

  const poolRef = useRef<PoolSlot[]>([]);
  const pool = useMemo(() => assignSlots(poolRef.current, wanted), [wanted]);
  useLayoutEffect(() => {
    poolRef.current = pool;
  }, [pool]);

  const videoRefs = useRef<Array<HTMLVideoElement | null>>([]);
  const layerById = useMemo(() => new Map(layers.map((l) => [l.item.id, l])), [layers]);

  // Slave every element to the clock: play and re-seek on drift while
  // playing, hold the exact frame while paused, and prepare the next clip.
  useEffect(() => {
    const showing: HTMLVideoElement[] = [];
    pool.forEach((slot, index) => {
      const el = videoRefs.current[index];
      if (!el) return;
      const item = slot.itemId ? edit.items.find((i) => i.id === slot.itemId) : undefined;
      if (!item || item.kind !== "video") {
        if (!el.paused) el.pause();
        el.muted = true;
        return;
      }
      const visible = layerById.has(item.id);
      const local = visible ? time - item.start : 0;
      const target = item.offset + local;
      const drift = Math.abs(el.currentTime - target);
      const track = trackOf(edit, item);
      const source = sourceOf(edit, item);
      const audible =
        visible && track?.kind === "main" && !track.muted && !track.hidden && Boolean(source?.hasAudio);
      el.muted = !audible;
      el.volume = audible ? Math.min(1, Math.max(0, audioGainAt(item, local))) : 0;

      if (visible && playing) {
        if (drift > PLAY_DRIFT && !el.seeking) el.currentTime = target;
        if (el.paused) void el.play().catch(() => undefined);
        showing.push(el);
      } else {
        if (!el.paused) el.pause();
        // A frame's worth is close enough to be showing the right picture.
        // While paused, nothing re-runs this until the playhead moves, so a
        // seek is never skipped for one still in flight: a new seek replaces
        // it, or the picture could be left where playback stopped.
        const tolerance = visible ? 0.5 / edit.canvas.fps : 0.05;
        if (drift > tolerance) el.currentTime = target;
      }
    });
    stalled.current = () =>
      showing.some(
        (el) => !el.ended && (el.seeking || el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA),
      );
  }, [pool, edit, time, playing, layerById, stalled]);

  // Nothing keeps playing once the preview is gone.
  useEffect(
    () => () => {
      for (const el of videoRefs.current) el?.pause();
      stalled.current = () => false;
    },
    [stalled],
  );

  // Dragging the selected item around the stage. Screen pixels become canvas
  // pixels through the stage's scale, then fractions of the canvas.
  const drag = useRef<{ id: string; x0: number; y0: number; px: number; py: number; key: string } | null>(null);
  const selectedLayer = selectedId ? layerById.get(selectedId) : undefined;
  // A moving item is dragged where it is at the playhead, which keys it there.
  const movable = Boolean(selectedLayer && onMoveSelected);

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !selectedLayer || !movable) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const key = transformAt(selectedLayer.item.transform, time - selectedLayer.item.start);
    drag.current = {
      id: selectedLayer.item.id,
      x0: key.x,
      y0: key.y,
      px: e.clientX,
      py: e.clientY,
      key: `stage:${selectedLayer.item.id}:${e.timeStamp}`,
    };
  };
  const moveDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || scale <= 0 || !onMoveSelected) return;
    const dx = (e.clientX - d.px) / scale / canvas.width;
    const dy = (e.clientY - d.py) / scale / canvas.height;
    onMoveSelected(d.id, d.x0 + dx, d.y0 + dy, d.key);
  };
  const endDrag = () => {
    drag.current = null;
  };

  const place = (layer: Layer | undefined) =>
    layer
      ? {
          left: layer.rect.x,
          top: layer.rect.y,
          width: layer.rect.w,
          height: layer.rect.h,
          opacity: layer.alpha,
          zIndex: layer.z,
          visibility: "visible" as const,
        }
      : { visibility: "hidden" as const };

  return (
    <div ref={paneRef} className="edit-preview">
      <div
        className="edit-stage"
        style={{
          width: canvas.width,
          height: canvas.height,
          transform: `translate(-50%, -50%) scale(${scale})`,
        }}
      >
        {pool.map((slot, index) => (
          <video
            key={index}
            ref={(el) => {
              videoRefs.current[index] = el;
            }}
            className="edit-layer"
            src={slot.path ? convertFileSrc(slot.path) : undefined}
            preload="auto"
            playsInline
            disablePictureInPicture
            style={place(slot.itemId ? layerById.get(slot.itemId) : undefined)}
          />
        ))}
        {layers.map((layer) => {
          if (layer.item.kind === "image") {
            const source = sourceOf(edit, layer.item);
            if (!source) return null;
            return (
              <img
                key={layer.item.id}
                className="edit-layer"
                src={convertFileSrc(source.path)}
                alt=""
                draggable={false}
                style={place(layer)}
              />
            );
          }
          if (layer.item.kind === "text") {
            const image = textImages?.get(layer.item.id);
            if (!image) return null;
            return (
              <img
                key={layer.item.id}
                className="edit-layer"
                src={image.url}
                alt=""
                draggable={false}
                style={place(layer)}
              />
            );
          }
          return null;
        })}
        {selectedLayer && (
          <div
            className={movable ? "edit-selection movable" : "edit-selection"}
            title={movable ? "Drag to move" : undefined}
            style={{
              left: selectedLayer.rect.x,
              top: selectedLayer.rect.y,
              width: selectedLayer.rect.w,
              height: selectedLayer.rect.h,
              // Drawn at screen thickness whatever the stage's scale.
              borderWidth: scale > 0 ? 1.5 / scale : 1,
            }}
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
        )}
      </div>
    </div>
  );
}
