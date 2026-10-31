import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Edit, EditItem, EditTrack } from "../../types";
import { itemEnd, previewUnsupported, sourceName, sourceOf } from "../../lib/edit";
import { snapTime } from "../../lib/voiceover";
import { clamp, formatShort } from "../../lib/time";
import { formatTick, prepareCanvas, tickStep } from "../../lib/ruler";
import { MAX_ZOOM, MIN_ZOOM, WHEEL_ZOOM_STEP, wheelPixels } from "../WaveformPane";

const RULER_HEIGHT = 24;
const MAIN_HEIGHT = 58;
const OVERLAY_HEIGHT = 40;
/** Pointer distance from an item edge that grabs the edge instead of the item. */
const EDGE_GRAB_PX = 6;
const SNAP_PX = 8;
/** Movement under this is still a click, not a drag. */
const CLICK_SLOP_PX = 3;
/** Room after the last item, so there is somewhere to drop the next one. */
const TAIL_SECONDS = 30;

type DragMode = "move" | "start" | "end" | "fadeIn" | "fadeOut";

interface Props {
  edit: Edit;
  time: number;
  playing: boolean;
  zoom: number;
  selectedId: string | null;
  onSeek: (t: number) => void;
  onZoomChange: (zoom: number) => void;
  onSelect: (id: string | null) => void;
  onMove: (id: string, start: number, trackId: string | undefined, drag: string) => void;
  onTrimStart: (id: string, t: number, drag: string) => void;
  onTrimEnd: (id: string, t: number, drag: string) => void;
  onFade: (id: string, edge: "in" | "out", seconds: number, drag: string) => void;
  onPatchTrack: (id: string, patch: Partial<Pick<EditTrack, "hidden" | "muted">>) => void;
  onAddTrack?: () => void;
  onRemoveTrack?: (id: string) => void;
  onRenameTrack?: (id: string, name: string) => void;
  /** +1 draws the track above the next one up; -1 below. */
  onMoveTrack?: (id: string, direction: number) => void;
  /** Moves an item's key to `t` seconds into the item. */
  onMoveKey?: (id: string, index: number, t: number, drag: string) => void;
}

/** The lane under a screen point, and the timeline time there: for drops from the media bin. */
export function laneAt(clientX: number, clientY: number, zoom: number): { trackId: string; time: number } | null {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (!(el instanceof HTMLElement)) continue;
    const trackId = el.dataset.editLane;
    if (!trackId) continue;
    const rect = el.getBoundingClientRect();
    return { trackId, time: Math.max(0, (clientX - rect.left) / zoom) };
  }
  return null;
}

function laneHeight(track: EditTrack): number {
  return track.kind === "main" ? MAIN_HEIGHT : OVERLAY_HEIGHT;
}

function itemLabel(edit: Edit, item: EditItem): string {
  if (item.kind === "text") return item.text.trim() || "Text";
  const source = sourceOf(edit, item);
  return source ? sourceName(source) : "Missing source";
}

/**
 * The Edit tab's timeline: a ruler, then the tracks with the topmost layer at
 * the top and the main track at the bottom. Items move by dragging, their
 * edges trim, and the small handles in their top corners set the fades.
 */
export function EditTimeline({
  edit,
  time,
  playing,
  zoom,
  selectedId,
  onSeek,
  onZoomChange,
  onSelect,
  onMove,
  onTrimStart,
  onTrimEnd,
  onFade,
  onPatchTrack,
  onAddTrack,
  onRemoveTrack,
  onRenameTrack,
  onMoveTrack,
  onMoveKey,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState({ left: 0, width: 0 });
  const pendingScroll = useRef<number | null>(null);
  const scrubbing = useRef(false);

  // Topmost layer first; the main track (index 0) last.
  const lanes = useMemo(() => [...edit.tracks].reverse(), [edit.tracks]);
  const end = edit.items.reduce((e, i) => Math.max(e, itemEnd(i)), 0);
  const contentWidth = Math.max(view.width, (end + TAIL_SECONDS) * zoom);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setView({ left: el.scrollLeft, width: el.clientWidth });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // After a zoom at the pointer, keep the time under it where it was.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || pendingScroll.current === null) return;
    el.scrollLeft = pendingScroll.current;
    pendingScroll.current = null;
  }, [zoom]);

  // Keep the playhead in view while playing.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !playing) return;
    const x = time * zoom;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth * 0.9) {
      el.scrollLeft = Math.max(0, x - el.clientWidth * 0.1);
    }
  }, [time, zoom, playing]);

  // Wheel: Alt to zoom at the pointer, otherwise pan — as on the other tabs.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const delta = wheelPixels(e);
      if (delta === 0) return;
      e.preventDefault();
      if (!e.altKey) {
        el.scrollLeft += delta;
        return;
      }
      const rect = el.getBoundingClientRect();
      const pointer = e.clientX - rect.left;
      const at = (el.scrollLeft + pointer) / zoom;
      const next = clamp(
        Math.round(delta < 0 ? zoom * WHEEL_ZOOM_STEP : zoom / WHEEL_ZOOM_STEP),
        MIN_ZOOM,
        MAX_ZOOM,
      );
      if (next === zoom) return;
      pendingScroll.current = Math.max(0, at * next - pointer);
      onZoomChange(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom, onZoomChange]);

  // The ruler, drawn for the visible window only.
  useEffect(() => {
    const canvas = rulerRef.current;
    if (!canvas || view.width === 0) return;
    const g = prepareCanvas(canvas, view.width, RULER_HEIGHT);
    if (!g) return;
    const step = tickStep(zoom);
    const first = Math.floor(view.left / zoom / step) * step;
    const last = (view.left + view.width) / zoom;
    g.strokeStyle = "#35435a";
    g.fillStyle = "#8b98aa";
    g.font = "10px system-ui, sans-serif";
    g.textBaseline = "top";
    for (let t = first; t <= last; t += step) {
      const x = Math.round(t * zoom - view.left) + 0.5;
      g.beginPath();
      g.moveTo(x, RULER_HEIGHT - 7);
      g.lineTo(x, RULER_HEIGHT);
      g.stroke();
      g.fillText(formatTick(t, step), x + 3, 4);
    }
  }, [view, zoom]);

  const timeAt = (clientX: number) => {
    const el = scrollerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left + el.scrollLeft) / zoom);
  };

  const startScrub = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubbing.current = true;
    onSeek(timeAt(e.clientX));
  };

  // --- Item gestures ---------------------------------------------------------
  const drag = useRef<{
    item: EditItem;
    mode: DragMode;
    key: string;
    pointerX: number;
    moved: boolean;
    snaps: number[];
  } | null>(null);

  const startItem = (e: ReactPointerEvent<HTMLDivElement>, item: EditItem, mode?: DragMode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const grabbable = rect.width > EDGE_GRAB_PX * 3;
    const chosen: DragMode =
      mode ?? (grabbable && x < EDGE_GRAB_PX ? "start" : grabbable && rect.width - x < EDGE_GRAB_PX ? "end" : "move");
    // Snap to the playhead, the start, and every other item's edges.
    const snaps = [time, 0];
    for (const other of edit.items) {
      if (other.id !== item.id) snaps.push(other.start, itemEnd(other));
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      item,
      mode: chosen,
      key: `${item.id}:${chosen}:${e.timeStamp}`,
      pointerX: e.clientX,
      moved: false,
      snaps,
    };
    onSelect(item.id);
  };

  const moveItemDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.pointerX;
    if (!d.moved && Math.abs(dx) < CLICK_SLOP_PX) return;
    d.moved = true;
    const dt = dx / zoom;
    const tolerance = SNAP_PX / zoom;
    const { item } = d;
    const snap = (t: number) => snapTime(t, d.snaps, tolerance);
    switch (d.mode) {
      case "move": {
        const raw = item.start + dt;
        let start = snap(raw);
        if (start === raw) start = snap(raw + item.duration) - item.duration;
        const lane = laneAt(e.clientX, e.clientY, zoom);
        onMove(item.id, start, lane?.trackId, d.key);
        break;
      }
      case "start":
        onTrimStart(item.id, snap(item.start + dt), d.key);
        break;
      case "end":
        onTrimEnd(item.id, snap(itemEnd(item) + dt), d.key);
        break;
      case "fadeIn":
        onFade(item.id, "in", item.fadeIn + dt, d.key);
        break;
      case "fadeOut":
        onFade(item.id, "out", item.fadeOut - dt, d.key);
        break;
    }
  };

  const endItemDrag = () => {
    drag.current = null;
  };

  // --- Key diamonds: drag to retime, click to go there -------------------------
  const keyDrag = useRef<{ item: EditItem; index: number; pointerX: number; moved: boolean; key: string } | null>(null);

  const startKey = (e: ReactPointerEvent<HTMLDivElement>, item: EditItem, index: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    keyDrag.current = { item, index, pointerX: e.clientX, moved: false, key: `key:${item.id}:${index}:${e.timeStamp}` };
    onSelect(item.id);
  };
  const moveKeyDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = keyDrag.current;
    if (!d || !onMoveKey) return;
    const dx = e.clientX - d.pointerX;
    if (!d.moved && Math.abs(dx) < CLICK_SLOP_PX) return;
    d.moved = true;
    const raw = d.item.transform[d.index].time + dx / zoom;
    // Snaps to the playhead, so a key lands exactly where the picture was set.
    const t = snapTime(raw, [time - d.item.start], SNAP_PX / zoom);
    onMoveKey(d.item.id, d.index, t, d.key);
  };
  const endKeyDrag = () => {
    const d = keyDrag.current;
    keyDrag.current = null;
    if (d && !d.moved) onSeek(d.item.start + d.item.transform[d.index].time);
  };

  const startLane = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    onSelect(null);
    startScrub(e);
  };

  return (
    <div className="vo-timeline edit-timeline">
      <div className="vo-headers">
        <div className="vo-header vo-header-ruler" style={{ height: RULER_HEIGHT }}>
          <span className="vo-time">{formatShort(time)}</span>
        </div>
        {lanes.map((track) => (
          <div
            key={track.id}
            className={track.hidden ? "vo-header dimmed" : "vo-header"}
            style={{ height: laneHeight(track) }}
          >
            <div className="vo-header-row">
              {track.kind === "overlay" && onRenameTrack ? (
                <input
                  className="vo-track-name-input"
                  value={track.name}
                  aria-label="Track name"
                  onChange={(e) => onRenameTrack(track.id, e.target.value)}
                />
              ) : (
                <span className="vo-track-name">{track.name}</span>
              )}
              {track.kind === "main" && (
                <button
                  type="button"
                  className={track.muted ? "vo-ms on mute" : "vo-ms"}
                  title={track.muted ? "Unmute the main track" : "Mute the main track"}
                  aria-pressed={track.muted}
                  onClick={() => onPatchTrack(track.id, { muted: !track.muted })}
                >
                  M
                </button>
              )}
              <button
                type="button"
                className={track.hidden ? "vo-ms on mute" : "vo-ms"}
                title={track.hidden ? "Show this track" : "Hide this track"}
                aria-pressed={track.hidden}
                onClick={() => onPatchTrack(track.id, { hidden: !track.hidden })}
              >
                H
              </button>
              {track.kind === "overlay" && onMoveTrack && (
                <>
                  <button
                    type="button"
                    className="vo-ms"
                    title="Draw this track above the one over it"
                    disabled={edit.tracks[edit.tracks.length - 1].id === track.id}
                    onClick={() => onMoveTrack(track.id, 1)}
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    className="vo-ms"
                    title="Draw this track below the one under it"
                    disabled={edit.tracks[1]?.id === track.id}
                    onClick={() => onMoveTrack(track.id, -1)}
                  >
                    ▼
                  </button>
                </>
              )}
              {track.kind === "overlay" && onRemoveTrack && (
                <button
                  type="button"
                  className="vo-ms"
                  title="Remove this track and what is on it"
                  onClick={() => onRemoveTrack(track.id)}
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        ))}
        {onAddTrack && (
          <div className="vo-header vo-header-add">
            <button type="button" className="small" onClick={onAddTrack}>
              + Overlay track
            </button>
          </div>
        )}
      </div>

      <div className="vo-lanes">
        <canvas
          ref={rulerRef}
          className="vo-canvas"
          style={{ top: 0, width: view.width, height: RULER_HEIGHT }}
        />
        <div
          ref={scrollerRef}
          className="vo-scroller"
          onScroll={(e) =>
            setView({ left: e.currentTarget.scrollLeft, width: e.currentTarget.clientWidth })
          }
        >
          <div className="vo-content" style={{ width: contentWidth }}>
            <div
              className="vo-lane vo-lane-ruler"
              style={{ height: RULER_HEIGHT }}
              onPointerDown={startScrub}
              onPointerMove={(e) => scrubbing.current && onSeek(timeAt(e.clientX))}
              onPointerUp={() => (scrubbing.current = false)}
            />
            {lanes.map((track) => (
              <div
                key={track.id}
                data-edit-lane={track.id}
                className={`vo-lane edit-lane${track.kind === "main" ? " main" : ""}${
                  track.hidden ? " hidden-track" : ""
                }`}
                style={{ height: laneHeight(track) }}
                onPointerDown={startLane}
                onPointerMove={(e) => scrubbing.current && onSeek(timeAt(e.clientX))}
                onPointerUp={() => (scrubbing.current = false)}
              >
                {edit.items
                  .filter((item) => item.trackId === track.id)
                  .map((item) => {
                    const width = Math.max(2, item.duration * zoom);
                    const fadeInPx = item.fadeIn * zoom;
                    const fadeOutPx = item.fadeOut * zoom;
                    const source = sourceOf(edit, item);
                    const warn = source ? previewUnsupported(source) : false;
                    return (
                      <div
                        key={item.id}
                        className={`vo-clip edit-item ${item.kind}${item.id === selectedId ? " selected" : ""}`}
                        style={{ left: item.start * zoom, width, top: 3, bottom: 3 }}
                        title={`${itemLabel(edit, item)} · ${formatShort(item.start)}–${formatShort(itemEnd(item))}`}
                        onPointerDown={(e) => startItem(e, item)}
                        onPointerMove={moveItemDrag}
                        onPointerUp={endItemDrag}
                        onPointerCancel={endItemDrag}
                      >
                        <svg className="edit-fades" width={width} height="100%" preserveAspectRatio="none" viewBox={`0 0 ${width} 10`}>
                          {fadeInPx > 0 && <polygon points={`0,0 ${fadeInPx},0 0,10`} />}
                          {fadeOutPx > 0 && <polygon points={`${width},0 ${width - fadeOutPx},0 ${width},10`} />}
                        </svg>
                        <span className="vo-clip-name">
                          {warn && <span title="The preview may not play this codec; the bake will.">⚠ </span>}
                          {itemLabel(edit, item)}
                        </span>
                        {width > 24 && (
                          <>
                            <div
                              className="edit-fade-handle"
                              style={{ left: Math.min(fadeInPx, width - 8) }}
                              title={`Fade in ${item.fadeIn.toFixed(2)} s`}
                              onPointerDown={(e) => startItem(e, item, "fadeIn")}
                              onPointerMove={moveItemDrag}
                              onPointerUp={endItemDrag}
                            />
                            <div
                              className="edit-fade-handle"
                              style={{ left: Math.max(0, width - fadeOutPx - 8) }}
                              title={`Fade out ${item.fadeOut.toFixed(2)} s`}
                              onPointerDown={(e) => startItem(e, item, "fadeOut")}
                              onPointerMove={moveItemDrag}
                              onPointerUp={endItemDrag}
                            />
                          </>
                        )}
                        {item.transform.length > 1 &&
                          item.transform.map((key, index) =>
                            key.time > item.duration + 1e-9 ? null : (
                              <div
                                key={index}
                                className="edit-key"
                                // Kept inside the item, which clips: a key at
                                // either end would otherwise be half hidden
                                // under the trim handle.
                                style={{ left: Math.min(width - 6, Math.max(6, key.time * zoom)) }}
                                title={`Key ${index + 1} at ${formatShort(item.start + key.time)}: ${Math.round(
                                  key.scale * 100,
                                )}%`}
                                onPointerDown={(e) => startKey(e, item, index)}
                                onPointerMove={moveKeyDrag}
                                onPointerUp={endKeyDrag}
                                onPointerCancel={() => (keyDrag.current = null)}
                              />
                            ),
                          )}
                      </div>
                    );
                  })}
              </div>
            ))}
            <div className="vo-playhead" style={{ left: time * zoom }} />
          </div>
        </div>
      </div>
    </div>
  );
}
