import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type {
  Cue,
  DuckSettings,
  GainPoint,
  Speaker,
  VoiceClip,
  VoiceTrack,
  Voiceover,
} from "../types";
import { addPoint, curveDb, dbToY, movePoint, removePoint, yToDb } from "../lib/automation";
import { contrastText, thoughtColor, withAlpha } from "../lib/colors";
import { clamp, formatShort } from "../lib/time";
import {
  DEFAULT_DUCK,
  MAX_DB,
  MAX_VOICE_TRACKS,
  MIN_DB,
  canAddTrack,
  clipEnd,
  dbToGain,
  isAudible,
  snapTime,
  voiceTracks,
  type ClipWarning,
  type TrackPatch,
} from "../lib/voiceover";
import { CLIP_PEAKS_PER_SECOND } from "../audio/mixer";
import {
  isSelected,
  selectionSize,
  type SelectionChange,
  type VoItem,
  type VoSelection,
} from "../lib/voSelection";
import { wheelPixels } from "./WaveformPane";
import { WHEEL_ZOOM_STEP, fitZoom, stepZoom } from "../lib/zoom";
import { formatTick, prepareCanvas, tickStep } from "../lib/ruler";

interface Props {
  voiceover: Voiceover;
  cues: Cue[];
  speakers: Speaker[];
  /** The video's waveform, signed peaks at `peaksPerSecond`. */
  peaks: number[] | null;
  peaksPerSecond: number;
  duration: number;
  currentTime: number;
  playing: boolean;
  zoom: number;
  follow: boolean;
  /** Cues and clips picked on the timeline. */
  selection: VoSelection;
  /** A decoded clip file's absolute peaks, or null while it is still decoding. */
  clipPeaks: (file: string) => Float32Array | null;
  /** Bumped whenever a file finishes decoding, so its waveform gets drawn. */
  decodeVersion: number;
  onSeek: (time: number) => void;
  onZoomChange: (zoom: number) => void;
  /** Bumped to zoom until the whole timeline fits, from the start. */
  fitRequest?: number;
  onSelect: (change: SelectionChange) => void;
  /** Every selected cue and clip moved by `delta` seconds; `drag` identifies the gesture. */
  onMoveSelection: (delta: number, drag: string) => void;
  onPatchTrack: (id: string, patch: TrackPatch) => void;
  onAddTrack: () => void;
  onRemoveTrack: (id: string) => void;
  onImport: (trackId: string) => void;
  /** `drag` identifies one gesture, so its updates merge into one undo step. */
  onMoveClip: (id: string, start: number, trackId: string, drag: string) => void;
  onTrimClip: (id: string, edge: "start" | "end", time: number, drag: string) => void;
  /** A new gain curve for a track; `drag` as for clips, absent for one-off edits. */
  onCurveChange: (trackId: string, points: GainPoint[], drag?: string) => void;
  /** The original's automatic duck under the cues, derived from `voiceover.duck`. */
  duck: GainPoint[];
  onToggleCueDuck: (cueId: string) => void;
  onDuckChange: (patch: Partial<DuckSettings>) => void;
  onDuckAllCues: () => void;
  /** Opens the audio export; absent while it cannot run (no video or no ffmpeg). */
  onExport?: () => void;
  /** Clips that need attention: their line changed, they overlap, or they overrun. */
  clipWarnings: Map<string, ClipWarning>;
  /** Boundaries between cues spoken as one line, as [end of one, start of next]. */
  lineJoins: Array<[number, number]>;
  /** Right-click on a cue block: the cue and where to open the menu. */
  onContextMenuCue: (cueId: string, x: number, y: number) => void;
  /** Double-click on a cue block: open its voice line for editing. */
  onEditCueLine: (cueId: string) => void;
  /**
   * A cue dragged to new times; only its timing changes. `kind` says whether
   * the whole cue moved or one edge did; `drag` identifies the gesture.
   */
  onRetimeCue: (
    id: string,
    start: number,
    end: number,
    kind: "move" | "resize",
    drag: string,
  ) => void;
}

const RULER_HEIGHT = 22;
const CUE_LANE_HEIGHT = 30;
/** Default lane heights; each track's own is set by dragging its header's edge. */
const ORIGINAL_LANE_HEIGHT = 72;
const VOICE_LANE_HEIGHT = 60;
const MIN_LANE_HEIGHT = 34;
const MAX_LANE_HEIGHT = 260;
/** Per-machine view state, like the panel widths: not part of the project. */
const HEIGHTS_STORAGE_KEY = "sst.trackHeights";
/** How long an emptied number field stays empty before it settles on zero. */
const EMPTY_SETTLE_MS = 700;
/** Space above and below a curve's range, so a point at the limit stays grabbable. */
const CURVE_PAD = 5;
const CURVE_STEP_PX = 3;
const DOUBLE_PRESS_MS = 350;
/** Gap between a clip and its lane's edges. */
const CLIP_INSET = 4;
/** The clip's name strip, above its waveform. */
const CLIP_LABEL_HEIGHT = 16;
/** Room after the video's end, so the last clip can be dragged past it. */
const TAIL_SECONDS = 10;
/** Pointer distance from a clip edge that grabs the edge instead of the clip. */
const EDGE_GRAB_PX = 6;
const SNAP_PX = 8;
/** A cue is short and its edges sit close together, so its grab zone is smaller. */
const CUE_EDGE_PX = 5;
/** Movement under this is still a click (which toggles the duck), not a drag. */
const CLICK_SLOP_PX = 3;
/** Cue blocks this far outside the view are not rendered at all. */
const WINDOW_PADDING_PX = 400;

type DragMode = "move" | "start" | "end";

export function VoiceoverTimeline({
  voiceover,
  cues,
  speakers,
  peaks,
  peaksPerSecond,
  duration,
  currentTime,
  playing,
  zoom,
  follow,
  selection,
  clipPeaks,
  decodeVersion,
  onSeek,
  onZoomChange,
  fitRequest = 0,
  onSelect,
  onMoveSelection,
  onPatchTrack,
  onAddTrack,
  onRemoveTrack,
  onImport,
  onMoveClip,
  onTrimClip,
  onCurveChange,
  duck,
  onToggleCueDuck,
  onDuckChange,
  onDuckAllCues,
  onExport,
  clipWarnings,
  lineJoins,
  onContextMenuCue,
  onEditCueLine,
  onRetimeCue,
}: Props) {
  const unducked = useMemo(() => new Set(voiceover.unduckedCueIds), [voiceover.unduckedCueIds]);
  /** Tracks whose curve is being edited. UI state, not part of the project. */
  const [editingCurves, setEditingCurves] = useState<Set<string>>(() => new Set());
  const [duckOpen, setDuckOpen] = useState(false);
  const toggleCurve = (id: string) =>
    setEditingCurves((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const rulerRef = useRef<HTMLCanvasElement | null>(null);
  const waveRef = useRef<HTMLCanvasElement | null>(null);
  const [view, setView] = useState({ left: 0, width: 0 });
  /** Scroll position to restore after a wheel zoom, keeping the pointer's moment put. */
  const pendingScroll = useRef<number | null>(null);
  const scrubbing = useRef(false);

  const original = voiceover.tracks.find((t) => t.kind === "original");
  const voices = voiceTracks(voiceover);

  const [heights, setHeights] = useState<Record<string, number>>(readHeights);
  useEffect(() => {
    try {
      localStorage.setItem(HEIGHTS_STORAGE_KEY, JSON.stringify(heights));
    } catch {
      // A forgotten height is not worth an error.
    }
  }, [heights]);
  const heightOf = (track: VoiceTrack) =>
    clamp(
      heights[track.id] ?? (track.kind === "original" ? ORIGINAL_LANE_HEIGHT : VOICE_LANE_HEIGHT),
      MIN_LANE_HEIGHT,
      MAX_LANE_HEIGHT,
    );
  const resizeTrack = (id: string, height: number | null) =>
    setHeights((current) => {
      const next = { ...current };
      if (height === null) delete next[id];
      else next[id] = clamp(Math.round(height), MIN_LANE_HEIGHT, MAX_LANE_HEIGHT);
      return next;
    });

  // Every track lane, top to bottom, with where it sits in the content.
  const lanes: Array<{ track: VoiceTrack; top: number; height: number }> = [];
  {
    let top = RULER_HEIGHT + CUE_LANE_HEIGHT;
    for (const track of original ? [original, ...voices] : voices) {
      const height = heightOf(track);
      lanes.push({ track, top, height });
      top += height;
    }
  }
  const laneOf = new Map(lanes.map((lane) => [lane.track.id, lane]));
  const originalHeight = original ? heightOf(original) : ORIGINAL_LANE_HEIGHT;
  const contentWidth = Math.ceil((Math.max(duration, 1) + TAIL_SECONDS) * zoom);

  // Fit: the whole timeline in view, from the start. Only a new request
  // fits; zooming afterwards must not re-fit.
  useEffect(() => {
    if (!fitRequest) return;
    const el = scrollerRef.current;
    const next = fitZoom(Math.max(duration, ...voiceover.clips.map(clipEnd)), el?.clientWidth ?? 0);
    if (next === null || !el) return;
    if (next !== zoom) {
      pendingScroll.current = 0;
      onZoomChange(next);
    } else {
      el.scrollLeft = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitRequest]);

  const speakerById = useMemo(() => new Map(speakers.map((s) => [s.id, s])), [speakers]);

  // --- Viewport -----------------------------------------------------------
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() =>
      setView({ left: el.scrollLeft, width: el.clientWidth }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Open on the playhead rather than at zero.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, currentTime * zoom - el.clientWidth * 0.3);
    setView({ left: el.scrollLeft, width: el.clientWidth });
    // Mount only: later moves of the playhead are `follow`'s business.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A zoom keeps one moment still on screen: the one under the pointer for a
  // wheel zoom, otherwise the playhead.
  const previousZoom = useRef(zoom);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const before = previousZoom.current;
    previousZoom.current = zoom;
    if (!el || before === zoom) return;
    if (pendingScroll.current !== null) {
      el.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
    } else {
      const onScreen = currentTime * before - el.scrollLeft;
      el.scrollLeft = Math.max(0, currentTime * zoom - onScreen);
    }
    setView({ left: el.scrollLeft, width: el.clientWidth });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  // Keep the playhead in view while playing, paging rather than centring so
  // the picture under a reading eye does not crawl.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !follow || !playing) return;
    const x = currentTime * zoom;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth * 0.9) {
      el.scrollLeft = Math.max(0, x - el.clientWidth * 0.1);
    }
  }, [currentTime, zoom, follow, playing]);

  // Wheel: Alt to zoom at the pointer, otherwise pan — the Subtitles
  // waveform's gestures. Not a React handler, because React registers wheel
  // listeners as passive and the page would scroll as well.
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
      const time = (el.scrollLeft + pointer) / zoom;
      const next = stepZoom(zoom, delta < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP);
      if (next === zoom) return;
      pendingScroll.current = Math.max(0, time * next - pointer);
      onZoomChange(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom, onZoomChange]);

  // --- Canvases: ruler and the original waveform --------------------------
  // Drawn for the visible window only: a canvas as wide as a long video at a
  // high zoom would exceed the browser's size limit.
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

  const peakScale = useMemo(() => {
    if (!peaks || peaks.length === 0) return 1;
    let max = 0;
    for (const p of peaks) max = Math.max(max, Math.abs(p));
    return max > 0 ? 1 / max : 1;
  }, [peaks]);

  useEffect(() => {
    const canvas = waveRef.current;
    if (!canvas || view.width === 0) return;
    const g = prepareCanvas(canvas, view.width, originalHeight);
    if (!g) return;

    // The automatic duck, as a shaded dip from the 0 dB line down to the curve.
    if (duck.length > 0) {
      const inner = originalHeight - CURVE_PAD * 2;
      const yOf = (db: number) => CURVE_PAD + dbToY(db) * inner;
      const zero = yOf(0);
      g.beginPath();
      g.moveTo(0, zero);
      for (let x = 0; x <= view.width + CURVE_STEP_PX; x += CURVE_STEP_PX) {
        g.lineTo(x, yOf(curveDb(duck, (view.left + x) / zoom)));
      }
      g.lineTo(view.width + CURVE_STEP_PX, zero);
      g.closePath();
      g.fillStyle = "rgba(74, 158, 255, 0.13)";
      g.fill();
    }

    if (!peaks || peaks.length === 0) return;
    const audible = original ? isAudible(voiceover, original) : true;
    const curve = original?.automation ?? [];
    g.fillStyle = audible ? "#3d4a5c" : "#262e3a";
    // Drawn as it will be heard through the curve and the duck, so a duck
    // shows as a dip in the waveform itself.
    drawPeaks(g, view.width, originalHeight, (x) => {
      const t0 = (view.left + x) / zoom;
      const t1 = (view.left + x + 1) / zoom;
      const i0 = Math.floor(t0 * peaksPerSecond);
      const i1 = Math.max(i0 + 1, Math.floor(t1 * peaksPerSecond));
      let peak = 0;
      for (let i = i0; i < i1 && i < peaks.length; i++) peak = Math.max(peak, Math.abs(peaks[i]));
      const db = curveDb(curve, t0) + curveDb(duck, t0);
      return peak * peakScale * (db === 0 ? 1 : dbToGain(db));
    });
  }, [view, zoom, peaks, peaksPerSecond, peakScale, original, voiceover, duck, originalHeight]);

  // --- Pointer: seeking and clip gestures ---------------------------------
  const timeAt = useCallback(
    (clientX: number) => {
      const el = scrollerRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      return Math.max(0, (clientX - rect.left + el.scrollLeft) / zoom);
    },
    [zoom],
  );

  const startScrub = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubbing.current = true;
    onSeek(timeAt(e.clientX));
  };
  const moveScrub = (e: ReactPointerEvent<HTMLElement>) => {
    if (scrubbing.current) onSeek(timeAt(e.clientX));
  };
  const endScrub = () => {
    scrubbing.current = false;
  };

  const snapCandidates = useMemo(() => {
    const times: number[] = [currentTime];
    for (const cue of cues) times.push(cue.start, cue.end);
    for (const clip of voiceover.clips) times.push(clip.start, clipEnd(clip));
    return times;
  }, [cues, voiceover.clips, currentTime]);

  // --- Pointer: cues and clips ---------------------------------------------
  // Cues and clips are picked and dragged alike. A press selects (Ctrl
  // toggles, Shift extends from the last item clicked); dragging a selected
  // item moves the whole selection; an edge trims one item. A cue's text
  // cannot change here, but its timing can, so it can be lined up with the
  // voice line generated for it.
  const itemDrag = useRef<{
    item: VoItem;
    mode: DragMode;
    key: string;
    pointerX: number;
    moved: boolean;
    /** The item's span when the press began. */
    start: number;
    end: number;
    clip?: VoiceClip;
    /** Moving every selected item, rather than this one alone. */
    group: boolean;
    /** Ctrl or Shift: a click that changes the selection, never a drag. */
    modifier: "toggle" | "range" | null;
  } | null>(null);

  /** Everything of the same kind between the last item clicked and `item`. */
  const rangeTo = (item: VoItem, start: number): VoItem[] => {
    const anchor = selection.primary;
    if (!anchor || anchor.kind !== item.kind) return [item];
    if (item.kind === "cue") {
      const from = cues.find((c) => c.id === anchor.id);
      if (!from) return [item];
      const [lo, hi] = [Math.min(from.start, start), Math.max(from.start, start)];
      return cues.filter((c) => c.start >= lo && c.start <= hi).map((c) => ({ kind: "cue", id: c.id }));
    }
    const from = voiceover.clips.find((c) => c.id === anchor.id);
    const to = voiceover.clips.find((c) => c.id === item.id);
    if (!from || !to) return [item];
    const [lo, hi] = [Math.min(from.start, start), Math.max(from.start, start)];
    const laneIndex = (trackId: string) => lanes.findIndex((l) => l.track.id === trackId);
    const [top, bottom] = [laneIndex(from.trackId), laneIndex(to.trackId)].sort((a, b) => a - b);
    return voiceover.clips
      .filter((c) => c.start >= lo && c.start <= hi)
      .filter((c) => laneIndex(c.trackId) >= top && laneIndex(c.trackId) <= bottom)
      .map((c) => ({ kind: "clip", id: c.id }));
  };

  const startItemDrag = (
    e: ReactPointerEvent<HTMLDivElement>,
    item: VoItem,
    start: number,
    end: number,
    edgePx: number,
    clip?: VoiceClip,
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const modifier = e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "range" : null;
    const rect = e.currentTarget.getBoundingClientRect();
    const grabbable = !modifier && rect.width > edgePx * 3;
    const mode: DragMode =
      grabbable && e.clientX - rect.left <= edgePx
        ? "start"
        : grabbable && rect.right - e.clientX <= edgePx
          ? "end"
          : "move";
    const selected = isSelected(selection, item);
    // Pressing an unselected item selects it at once, so the drag that may
    // follow moves it and it alone.
    if (!modifier && !selected) onSelect({ items: [item], mode: "replace" });
    e.currentTarget.setPointerCapture(e.pointerId);
    itemDrag.current = {
      item,
      mode,
      key: `${item.id}:${mode}:${Date.now()}`,
      pointerX: e.clientX,
      moved: false,
      start,
      end,
      clip,
      group: !modifier && selected && selectionSize(selection) > 1 && mode === "move",
      modifier,
    };
  };

  const moveItemDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = itemDrag.current;
    if (!d || d.modifier) return;
    if (!d.moved && Math.abs(e.clientX - d.pointerX) < CLICK_SLOP_PX) return;
    d.moved = true;
    const delta = (e.clientX - d.pointerX) / zoom;
    // Nothing snaps to an edge that is itself moving. Alt drags freely, the
    // way it does in most editors.
    const moving = (t: number) =>
      d.group
        ? [...selection.cues].some((id) => {
            const c = cues.find((x) => x.id === id);
            return c !== undefined && (c.start === t || c.end === t);
          }) ||
          [...selection.clips].some((id) => {
            const c = voiceover.clips.find((x) => x.id === id);
            return c !== undefined && (c.start === t || clipEnd(c) === t);
          })
        : t === d.start || t === d.end;
    const candidates = snapCandidates.filter((t) => !moving(t));
    const snap = (t: number) => (e.altKey ? t : snapTime(t, candidates, SNAP_PX / zoom));
    const length = d.end - d.start;

    if (d.mode === "move") {
      // Either edge may snap; the one with the shorter jump wins.
      const raw = Math.max(0, d.start + delta);
      const byHead = snap(raw);
      const byTail = snap(raw + length) - length;
      const headJump = byHead === raw ? Infinity : Math.abs(byHead - raw);
      const tailJump = byTail === raw ? Infinity : Math.abs(byTail - raw);
      const next =
        headJump === Infinity && tailJump === Infinity ? raw : headJump <= tailJump ? byHead : byTail;
      if (d.group) onMoveSelection(next - d.start, d.key);
      else if (d.clip) {
        const trackId = laneUnder(e.clientX, e.clientY) ?? d.clip.trackId;
        onMoveClip(d.item.id, next, trackId, d.key);
      } else onRetimeCue(d.item.id, next, next + length, "move", d.key);
    } else if (d.clip) {
      if (d.mode === "start") onTrimClip(d.item.id, "start", snap(d.start + delta), d.key);
      else onTrimClip(d.item.id, "end", snap(d.end + delta), d.key);
    } else if (d.mode === "start") {
      onRetimeCue(d.item.id, snap(d.start + delta), d.end, "resize", d.key);
    } else {
      onRetimeCue(d.item.id, d.start, snap(d.end + delta), "resize", d.key);
    }
  };

  const endItemDrag = () => {
    const d = itemDrag.current;
    itemDrag.current = null;
    if (!d || d.moved) return;
    if (d.modifier === "toggle") onSelect({ items: [d.item], mode: "toggle" });
    else if (d.modifier === "range") {
      onSelect({ items: rangeTo(d.item, d.start), mode: "add", primary: d.item });
    }
    // A plain click on one of several selected items narrows to it.
    else onSelect({ items: [d.item], mode: "replace" });
  };

  // --- Pointer: empty lane space ----------------------------------------------
  // A plain press clears the selection and scrubs; Ctrl or Shift draws a box
  // that selects every cue and clip it touches.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number; add: boolean } | null>(
    null,
  );

  const contentPoint = (e: ReactPointerEvent<HTMLElement>) => {
    const rect = contentRef.current?.getBoundingClientRect();
    return rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : { x: 0, y: 0 };
  };

  const startLane = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      e.currentTarget.setPointerCapture(e.pointerId);
      const { x, y } = contentPoint(e);
      setBox({ x0: x, y0: y, x1: x, y1: y, add: true });
      return;
    }
    onSelect({ items: [], mode: "replace" });
    startScrub(e);
  };

  const moveLane = (e: ReactPointerEvent<HTMLElement>) => {
    if (box) {
      const { x, y } = contentPoint(e);
      setBox({ ...box, x1: x, y1: y });
      return;
    }
    moveScrub(e);
  };

  const endLane = () => {
    endScrub();
    if (!box) return;
    setBox(null);
    const [left, right] = [Math.min(box.x0, box.x1), Math.max(box.x0, box.x1)];
    const [top, bottom] = [Math.min(box.y0, box.y1), Math.max(box.y0, box.y1)];
    const [from, to] = [left / zoom, right / zoom];
    const overlaps = (a: number, b: number, lo: number, hi: number) => a < hi && b > lo;
    const items: VoItem[] = [];
    if (overlaps(RULER_HEIGHT, RULER_HEIGHT + CUE_LANE_HEIGHT, top, bottom)) {
      for (const cue of cues) {
        if (overlaps(cue.start, cue.end, from, to)) items.push({ kind: "cue", id: cue.id });
      }
    }
    for (const clip of voiceover.clips) {
      const lane = laneOf.get(clip.trackId);
      if (!lane || lane.track.kind !== "voice") continue;
      const clipTop = lane.top + CLIP_INSET;
      const clipBottom = lane.top + lane.height - CLIP_INSET;
      if (overlaps(clipTop, clipBottom, top, bottom) && overlaps(clip.start, clipEnd(clip), from, to)) {
        items.push({ kind: "clip", id: clip.id });
      }
    }
    onSelect({ items, mode: box.add ? "add" : "replace" });
  };

  // --- Render -------------------------------------------------------------
  const visibleFrom = (view.left - WINDOW_PADDING_PX) / zoom;
  const visibleTo = (view.left + view.width + WINDOW_PADDING_PX) / zoom;
  const visibleCues = cues.filter((c) => c.end >= visibleFrom && c.start <= visibleTo);
  const anySolo = voiceover.tracks.some((t) => t.solo);

  return (
    <div className="vo-timeline">
      <div className="vo-headers">
        <div className="vo-header vo-header-ruler" style={{ height: RULER_HEIGHT }}>
          <span className="vo-time">{formatShort(currentTime)}</span>
        </div>
        <div className="vo-header vo-header-cues" style={{ height: CUE_LANE_HEIGHT }}>
          <span className="vo-track-name">Cues</span>
          <span className="vo-track-note">read-only</span>
        </div>
        {original && (
          <TrackHeader
            track={original}
            height={originalHeight}
            dimmed={!isAudible(voiceover, original)}
            curveEditing={editingCurves.has(original.id)}
            onToggleCurve={() => toggleCurve(original.id)}
            onPatch={(patch) => onPatchTrack(original.id, patch)}
            onDuck={() => setDuckOpen((open) => !open)}
            duckOn={voiceover.duck.enabled}
            onResize={(h) => resizeTrack(original.id, h)}
          />
        )}
        {voices.map((track) => (
          <TrackHeader
            key={track.id}
            track={track}
            height={heightOf(track)}
            dimmed={!isAudible(voiceover, track)}
            curveEditing={editingCurves.has(track.id)}
            onToggleCurve={() => toggleCurve(track.id)}
            onPatch={(patch) => onPatchTrack(track.id, patch)}
            onImport={() => onImport(track.id)}
            onRemove={() => onRemoveTrack(track.id)}
            onResize={(h) => resizeTrack(track.id, h)}
          />
        ))}
        <div className="vo-header vo-header-add">
          <button
            type="button"
            className="small"
            disabled={!canAddTrack(voiceover)}
            onClick={onAddTrack}
            title={`Up to ${MAX_VOICE_TRACKS} voice tracks`}
          >
            + Track
          </button>
          <button
            type="button"
            className="small"
            disabled={!onExport}
            onClick={onExport}
            title="Render the mix to an audio file"
          >
            Export…
          </button>
        </div>
      </div>

      <div className="vo-lanes">
        {/* Behind the scroller, which is transparent where these show through. */}
        <canvas
          ref={rulerRef}
          className="vo-canvas"
          style={{ top: 0, width: view.width, height: RULER_HEIGHT }}
        />
        <canvas
          ref={waveRef}
          className="vo-canvas"
          style={{
            top: RULER_HEIGHT + CUE_LANE_HEIGHT,
            width: view.width,
            height: originalHeight,
          }}
        />

        <div
          ref={scrollerRef}
          className="vo-scroller"
          onScroll={(e) =>
            setView({ left: e.currentTarget.scrollLeft, width: e.currentTarget.clientWidth })
          }
        >
          <div ref={contentRef} className="vo-content" style={{ width: contentWidth }}>
            <div
              className="vo-lane vo-lane-ruler"
              style={{ height: RULER_HEIGHT }}
              onPointerDown={startScrub}
              onPointerMove={moveScrub}
              onPointerUp={endScrub}
            />

            <div
              className="vo-lane vo-lane-cues"
              style={{ height: CUE_LANE_HEIGHT }}
              onPointerDown={startLane}
              onPointerMove={moveLane}
              onPointerUp={endLane}
            >
              {visibleCues.map((cue) => {
                const speaker = cue.speakerId ? speakerById.get(cue.speakerId) ?? null : null;
                const color =
                  cue.mode === "thought" ? thoughtColor(speaker) : speaker?.color ?? "#5b6b80";
                const ducked = !unducked.has(cue.id);
                const selected = selection.cues.has(cue.id);
                return (
                  <div
                    key={cue.id}
                    className={`vo-cue${ducked ? "" : " unducked"}${selected ? " selected" : ""}`}
                    style={{
                      left: cue.start * zoom,
                      width: Math.max(2, (cue.end - cue.start) * zoom),
                      background: withAlpha(color, ducked ? 0.75 : 0.22),
                      color: ducked ? contrastText(color) : "var(--text-dim)",
                      borderColor: selected ? undefined : color,
                    }}
                    // The text is read-only here. A click selects, a drag
                    // retimes (with the rest of the selection), a right-click
                    // offers the cue's line.
                    onPointerDown={(e) =>
                      startItemDrag(e, { kind: "cue", id: cue.id }, cue.start, cue.end, CUE_EDGE_PX)
                    }
                    onPointerMove={moveItemDrag}
                    onPointerUp={endItemDrag}
                    onPointerCancel={() => {
                      itemDrag.current = null;
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onContextMenuCue(cue.id, e.clientX, e.clientY);
                    }}
                    onDoubleClick={() => onEditCueLine(cue.id)}
                    title={`${speaker ? `${speaker.name}: ` : ""}${cue.text}\n${
                      ducked ? "Ducked" : "Not ducked"
                    } · click to select, drag to move, drag an edge to trim · double-click for its voice line · right-click for more`}
                  >
                    <button
                      type="button"
                      className="vo-cue-duck"
                      // Its own press: neither a selection nor a drag.
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        if (e.button === 0) onToggleCueDuck(cue.id);
                      }}
                      onDoubleClick={(e) => e.stopPropagation()}
                      title={ducked ? "Ducked — click to let the original through" : "Not ducked — click to duck"}
                      aria-label={ducked ? "Stop ducking under this cue" : "Duck under this cue"}
                    >
                      {ducked ? "◐" : "○"}
                    </button>
                    {cue.text}
                  </div>
                );
              })}
              {lineJoins
                .filter(([a, b]) => b >= visibleFrom && a <= visibleTo)
                .map(([a, b]) => (
                  <div
                    key={`join-${a}`}
                    className="vo-join"
                    style={{ left: a * zoom - 3, width: Math.max(6, (b - a) * zoom + 6) }}
                    title="Spoken as one line — right-click a cue to split it"
                  />
                ))}
            </div>

            <div
              className="vo-lane vo-lane-original"
              style={{ height: originalHeight }}
              onPointerDown={startLane}
              onPointerMove={moveLane}
              onPointerUp={endLane}
            />

            {voices.map((track) => (
              <div
                key={track.id}
                className={`vo-lane vo-lane-voice${isAudible(voiceover, track) ? "" : " silent"}`}
                data-track-id={track.id}
                style={{ height: heightOf(track) }}
                onPointerDown={startLane}
                onPointerMove={moveLane}
                onPointerUp={endLane}
              />
            ))}

            {/*
              One layer for every clip rather than clips inside their lanes: a
              clip dragged onto another track would otherwise be remounted under
              its new lane, and the remount drops the pointer capture mid-drag.
            */}
            <div className="vo-clip-layer" style={{ top: 0 }}>
              {voiceover.clips.map((clip) => {
                const lane = laneOf.get(clip.trackId);
                if (!lane || lane.track.kind !== "voice") return null;
                return (
                  <ClipBlock
                    key={clip.id}
                    clip={clip}
                    // A lane in curve editing belongs to the curve's points.
                    passive={editingCurves.has(clip.trackId)}
                    warning={clipWarnings.get(clip.id) ?? null}
                    top={lane.top + CLIP_INSET}
                    height={lane.height - CLIP_INSET * 2}
                    zoom={zoom}
                    selected={selection.clips.has(clip.id)}
                    peaks={clipPeaks(clip.file)}
                    decodeVersion={decodeVersion}
                    onPointerDown={(e) =>
                      startItemDrag(e, { kind: "clip", id: clip.id }, clip.start, clipEnd(clip), EDGE_GRAB_PX, clip)
                    }
                    onPointerMove={moveItemDrag}
                    onPointerUp={endItemDrag}
                  />
                );
              })}
            </div>

            {box && (
              <div
                className="vo-box"
                style={{
                  left: Math.min(box.x0, box.x1),
                  top: Math.min(box.y0, box.y1),
                  width: Math.abs(box.x1 - box.x0),
                  height: Math.abs(box.y1 - box.y0),
                }}
              />
            )}

            {lanes.map(({ track, top, height }) =>
              track.automation.length > 0 || editingCurves.has(track.id) ? (
                <CurveOverlay
                  key={track.id}
                  points={track.automation}
                  top={top}
                  height={height}
                  view={view}
                  zoom={zoom}
                  editing={editingCurves.has(track.id)}
                  snapCandidates={snapCandidates}
                  onChange={(points, drag) => onCurveChange(track.id, points, drag)}
                />
              ) : null,
            )}

            <div className="vo-playhead" style={{ left: currentTime * zoom }} />
          </div>
        </div>
      </div>

      {anySolo && <div className="vo-solo-note">Solo on — unsoloed tracks are silent</div>}

      {duckOpen && (
        <DuckPanel
          settings={voiceover.duck}
          cueCount={cues.length}
          unduckedCount={cues.filter((cue) => unducked.has(cue.id)).length}
          onChange={onDuckChange}
          onDuckAll={onDuckAllCues}
          onClose={() => setDuckOpen(false)}
        />
      )}
    </div>
  );
}

function TrackHeader({
  track,
  height,
  dimmed,
  curveEditing,
  onToggleCurve,
  onPatch,
  onDuck,
  duckOn = false,
  onImport,
  onRemove,
  onResize,
}: {
  duckOn?: boolean;
  /** A new lane height, or null to return to the default. */
  onResize: (height: number | null) => void;
  track: VoiceTrack;
  height: number;
  dimmed: boolean;
  curveEditing: boolean;
  onToggleCurve: () => void;
  onPatch: (patch: TrackPatch) => void;
  onDuck?: () => void;
  onImport?: () => void;
  onRemove?: () => void;
}) {
  const curveTitle = curveEditing
    ? "Stop editing the gain curve"
    : "Edit the gain curve: click to add a point, drag to move (Shift keeps its time), double- or right-click to remove";
  const resize = useRef<{ y: number; height: number } | null>(null);
  return (
    <div className={`vo-header${dimmed ? " dimmed" : ""}`} style={{ height }}>
      <div
        className="vo-resize"
        role="separator"
        aria-orientation="horizontal"
        title="Drag to resize the track — double-click for the default height"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          resize.current = { y: e.clientY, height };
        }}
        onPointerMove={(e) => {
          if (resize.current) onResize(resize.current.height + e.clientY - resize.current.y);
        }}
        onPointerUp={() => {
          resize.current = null;
        }}
        onPointerCancel={() => {
          resize.current = null;
        }}
        onDoubleClick={() => onResize(null)}
      />
      <div className="vo-header-row">
        {track.kind === "original" ? (
          <span className="vo-track-name">{track.name}</span>
        ) : (
          <input
            className="vo-track-name-input"
            value={track.name}
            onChange={(e) => onPatch({ name: e.target.value })}
            aria-label="Track name"
          />
        )}
        <button
          type="button"
          className={track.muted ? "vo-ms on mute" : "vo-ms"}
          onClick={() => onPatch({ muted: !track.muted })}
          title="Mute"
        >
          M
        </button>
        <button
          type="button"
          className={track.solo ? "vo-ms on solo" : "vo-ms"}
          onClick={() => onPatch({ solo: !track.solo })}
          title="Solo"
        >
          S
        </button>
        <button
          type="button"
          className={curveEditing ? "vo-ms on curve" : track.automation.length ? "vo-ms has-curve" : "vo-ms"}
          onClick={onToggleCurve}
          title={curveTitle}
        >
          ◇
        </button>
      </div>
      <div className="vo-header-row">
        <input
          type="range"
          className="vo-gain"
          min={MIN_DB}
          max={MAX_DB}
          step={0.5}
          value={track.gainDb}
          onChange={(e) => onPatch({ gainDb: Number(e.target.value) })}
          onDoubleClick={() => onPatch({ gainDb: 0 })}
          title="Track gain — double-click for 0 dB"
        />
        <span className="vo-gain-value">{formatDb(track.gainDb)}</span>
      </div>
      {(onImport || onRemove || onDuck) && (
        <div className="vo-header-row">
          {onDuck && (
            <button
              type="button"
              className={duckOn ? "small toggle on" : "small"}
              // Keeps focus in an open panel, so this click closes it rather
              // than the panel closing on blur and this click reopening it.
              onMouseDown={(e) => e.preventDefault()}
              onClick={onDuck}
              title={
                duckOn
                  ? "Ducking under cues is on — open its settings"
                  : "Ducking under cues is off — open its settings"
              }
            >
              Ducking…
            </button>
          )}
          {onImport && (
            <button type="button" className="small" onClick={onImport} title="Place audio files at the playhead">
              + Audio
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              className="small vo-remove"
              onClick={onRemove}
              title="Remove this track and its clips"
            >
              ×
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A track's gain curve, drawn over its lane for the visible window only. It
 * takes the pointer only while the track is in curve editing.
 */
function CurveOverlay({
  points,
  top,
  height,
  view,
  zoom,
  editing,
  snapCandidates,
  onChange,
}: {
  points: GainPoint[];
  top: number;
  height: number;
  view: { left: number; width: number };
  zoom: number;
  editing: boolean;
  snapCandidates: number[];
  onChange: (points: GainPoint[], drag?: string) => void;
}) {
  const drag = useRef<{ index: number; points: GainPoint[]; key: string; time: number } | null>(null);
  const lastPress = useRef<{ index: number; at: number } | null>(null);
  const inner = height - CURVE_PAD * 2;
  const yOf = (db: number) => CURVE_PAD + dbToY(db) * inner;

  const at = (e: ReactPointerEvent<SVGSVGElement>, freeTime: boolean) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const raw = Math.max(0, (view.left + e.clientX - rect.left) / zoom);
    const time = freeTime || e.altKey ? raw : snapTime(raw, snapCandidates, SNAP_PX / zoom);
    return { time, db: yToDb((e.clientY - rect.top - CURVE_PAD) / inner) };
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!editing || e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const key = `curve:${Date.now()}`;
    const hit = (e.target as Element).getAttribute?.("data-index");
    if (hit !== null && hit !== undefined) {
      const index = Number(hit);
      // Pointer capture sends the click to the svg, not the point, so a
      // double-click is recognised here rather than by a dblclick handler.
      const now = Date.now();
      const last = lastPress.current;
      lastPress.current = { index, at: now };
      if (last && last.index === index && now - last.at < DOUBLE_PRESS_MS) {
        lastPress.current = null;
        drag.current = null;
        onChange(removePoint(points, index));
        return;
      }
      drag.current = { index, points, key, time: points[index].time };
      return;
    }
    lastPress.current = null;
    const added = addPoint(points, at(e, false));
    drag.current = { index: added.index, points: added.points, key, time: added.points[added.index].time };
    onChange(added.points, key);
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const point = at(e, false);
    // Shift moves the level only, leaving the point where it is in time.
    const next = movePoint(d.points, d.index, e.shiftKey ? { time: d.time, db: point.db } : point);
    if (next !== d.points) onChange(next, d.key);
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  // The curve, sampled every few pixels across the window.
  const segments: string[] = [];
  for (let x = 0; x <= view.width + CURVE_STEP_PX; x += CURVE_STEP_PX) {
    const y = yOf(curveDb(points, (view.left + x) / zoom));
    segments.push(`${segments.length === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const from = view.left / zoom;
  const to = (view.left + view.width) / zoom;

  return (
    <svg
      className={editing ? "vo-curve editing" : "vo-curve"}
      style={{ left: view.left, top, width: view.width, height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {editing && (
        <line
          className="vo-curve-zero"
          x1={0}
          x2={view.width}
          y1={yOf(0)}
          y2={yOf(0)}
        />
      )}
      <path className="vo-curve-line" d={segments.join("")} />
      {editing &&
        points.map((p, i) =>
          p.time < from - 1 || p.time > to + 1 ? null : (
            <circle
              key={i}
              data-index={i}
              className="vo-curve-point"
              cx={p.time * zoom - view.left}
              cy={yOf(p.db)}
              r={4.5}
              onContextMenu={(e) => {
                e.preventDefault();
                onChange(removePoint(points, i));
              }}
            >
              <title>
                {formatShort(p.time)} · {formatDb(p.db)}
              </title>
            </circle>
          ),
        )}
    </svg>
  );
}

/**
 * The settings of the original track's automatic duck. Every change applies
 * at once — there is nothing to apply — and each control is one undo step.
 */
function DuckPanel({
  settings,
  cueCount,
  unduckedCount,
  onChange,
  onDuckAll,
  onClose,
}: {
  settings: DuckSettings;
  cueCount: number;
  unduckedCount: number;
  onChange: (patch: Partial<DuckSettings>) => void;
  onDuckAll: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Focus the panel itself on open, so that leaving it closes it even when no
  // field was ever clicked.
  useEffect(() => panelRef.current?.focus(), []);

  const timing = (key: "attack" | "release" | "bridge", label: string, max: number) => (
    <label className="duck-field">
      <span>{label}</span>
      <DraftNumber
        value={Math.round(settings[key] * 1000)}
        min={0}
        max={max}
        step={10}
        disabled={!settings.enabled}
        onCommit={(ms) => onChange({ [key]: ms / 1000 })}
      />
      <span className="duck-unit">ms</span>
    </label>
  );

  return (
    <div
      ref={panelRef}
      className="duck-panel"
      role="dialog"
      aria-label="Ducking"
      // Focusable, so a click on its padding or text keeps focus inside it.
      tabIndex={-1}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // Before the editor's own Escape, which would deselect the clip.
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="duck-header">
        <label className="duck-enable">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
          />
          <span>Duck the original under cues</span>
        </label>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {/* Typed as a positive amount — "duck by 15" — so no minus sign is needed. */}
      <label className="duck-field">
        <span>Duck by</span>
        <DraftNumber
          value={-settings.depthDb}
          min={0}
          max={-MIN_DB}
          step={1}
          disabled={!settings.enabled}
          onCommit={(db) => onChange({ depthDb: -db })}
        />
        <span className="duck-unit">dB</span>
      </label>
      {timing("attack", "Fade down", 3000)}
      {timing("release", "Fade up", 5000)}
      {timing("bridge", "Bridge gaps", 10000)}
      <p className="hint">
        Gaps between cues shorter than the bridge stay ducked. Click a cue on the timeline to
        switch its duck off or on.
      </p>
      <div className="duck-actions">
        <span className="duck-count">
          {cueCount - unduckedCount} of {cueCount} cues ducked
        </span>
        <button
          type="button"
          className="small"
          disabled={unduckedCount === 0}
          onClick={() => {
            // The button disables itself, which drops its focus — move it to
            // the panel first, or losing it would close the panel.
            panelRef.current?.focus();
            onDuckAll();
          }}
          title="Switch the duck back on for every cue"
        >
          Duck all
        </button>
        <button
          type="button"
          className="small"
          onClick={() => onChange({ ...DEFAULT_DUCK, enabled: settings.enabled })}
          title="Restore the default depth and timings"
        >
          Defaults
        </button>
      </div>
    </div>
  );
}

/**
 * A number field that tolerates being emptied. Valid input applies as it is
 * typed; an empty field is left empty for a moment, so the next digit can
 * replace the old number, and then settles on zero (sooner if focus leaves).
 * Input that is not a number yet — a lone "." — waits, and is dropped on blur.
 */
function DraftNumber({
  value,
  min,
  max,
  step,
  disabled,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  /** What is being typed; null shows the committed value. */
  const [draft, setDraft] = useState<string | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  const cancelSettle = () => {
    if (settle.current !== null) clearTimeout(settle.current);
    settle.current = null;
  };
  useEffect(() => cancelSettle, []);

  const commit = (n: number) => commitRef.current(clamp(n, min, max));
  const parse = (text: string) => {
    const n = Number(text.trim().replace(",", "."));
    return text.trim() !== "" && Number.isFinite(n) ? n : null;
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft ?? String(Math.round(value * 100) / 100)}
      disabled={disabled}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        cancelSettle();
        if (text.trim() === "") {
          settle.current = setTimeout(() => {
            settle.current = null;
            commit(0);
            setDraft(null);
          }, EMPTY_SETTLE_MS);
          return;
        }
        const n = parse(text);
        if (n !== null) commit(n);
      }}
      onBlur={() => {
        cancelSettle();
        if (draft !== null && draft.trim() === "") commit(0);
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          cancelSettle();
          const base = (draft !== null ? parse(draft) : null) ?? value;
          commit(base + (e.key === "ArrowUp" ? step : -step) * (e.shiftKey ? 10 : 1));
          setDraft(null);
        } else if (e.key === "Enter") {
          cancelSettle();
          if (draft !== null && draft.trim() === "") commit(0);
          setDraft(null);
        }
      }}
    />
  );
}

function ClipBlock({
  clip,
  passive,
  warning,
  top,
  height,
  zoom,
  selected,
  peaks,
  decodeVersion,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  clip: VoiceClip;
  passive: boolean;
  warning: ClipWarning | null;
  top: number;
  height: number;
  zoom: number;
  selected: boolean;
  peaks: Float32Array | null;
  decodeVersion: number;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const width = Math.max(3, clip.duration * zoom);
  // Long clips at high zoom would pass the canvas size limit; draw coarser.
  const canvasWidth = Math.min(Math.round(width), 8000);
  // A short lane drops the waveform and keeps the name.
  const waveHeight = Math.max(0, height - CLIP_LABEL_HEIGHT - 2);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g = prepareCanvas(canvas, canvasWidth, waveHeight);
    if (!g || !peaks) return;
    g.fillStyle = "rgba(230, 236, 243, 0.55)";
    const perPx = clip.duration / canvasWidth;
    drawPeaks(g, canvasWidth, waveHeight, (x) => {
      const i0 = Math.floor((clip.offset + x * perPx) * CLIP_PEAKS_PER_SECOND);
      const i1 = Math.max(i0 + 1, Math.floor((clip.offset + (x + 1) * perPx) * CLIP_PEAKS_PER_SECOND));
      let peak = 0;
      for (let i = i0; i < i1 && i < peaks.length; i++) peak = Math.max(peak, peaks[i]);
      return peak;
    });
  }, [peaks, decodeVersion, canvasWidth, waveHeight, clip.offset, clip.duration]);

  return (
    <div
      className={`vo-clip${selected ? " selected" : ""}${passive ? " passive" : ""}${
        warning ? ` ${warning}` : ""
      }`}
      style={{ left: clip.start * zoom, top, width, height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      title={`${clip.name} · ${formatShort(clip.start)}–${formatShort(clipEnd(clip))}${
        warning === "stale"
          ? "\nIts cue has changed since it was spoken."
          : warning === "overlap"
            ? "\nPlays over another clip on this track."
            : warning === "overrun"
              ? "\nRuns past the end of its cue."
              : ""
      }`}
    >
      <span className="vo-clip-name">
        {warning && <span className="vo-clip-warning">⚠ </span>}
        {clip.name}
      </span>
      <canvas
        ref={canvasRef}
        className="vo-clip-wave"
        style={{ width: "100%", height: waveHeight }}
      />
    </div>
  );
}

function readHeights(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HEIGHTS_STORAGE_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

/** The voice lane under a point, found through the DOM so it survives scrolling. */
function laneUnder(x: number, y: number): string | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const id = el instanceof HTMLElement ? el.dataset.trackId : undefined;
    if (id) return id;
  }
  return null;
}

/** Sizes a canvas for the device pixel ratio and returns a cleared context. */
/** Mirrored bars around the centre line, one per pixel column. */
function drawPeaks(
  g: CanvasRenderingContext2D,
  width: number,
  height: number,
  peakAt: (x: number) => number,
) {
  const mid = height / 2;
  for (let x = 0; x < width; x++) {
    const h = Math.max(0.5, Math.min(1, peakAt(x)) * (mid - 2));
    g.fillRect(x, mid - h, 1, h * 2);
  }
}

export function formatDb(db: number): string {
  if (db <= MIN_DB) return "−∞ dB";
  return `${db > 0 ? "+" : db < 0 ? "−" : ""}${Math.abs(db).toFixed(1)} dB`;
}
