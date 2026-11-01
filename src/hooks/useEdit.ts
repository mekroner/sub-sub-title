import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Edit } from "../types";
import {
  MAIN_TRACK_ID,
  editEnd,
  itemEnd,
  moveItem,
  placeSource,
  removeItem,
  setFade,
  splitItem,
  trimItemEnd,
  trimItemStart,
  trackItems,
} from "../lib/edit";
import { clamp } from "../lib/time";
import { makeId } from "../lib/ids";
import { WHEEL_ZOOM_STEP, stepZoom } from "../lib/zoom";

/** Longest the clock waits for the preview to catch up, in milliseconds. */
const MAX_STALL_MS = 1500;

/** Changes the edit through the project history; `mergeKey` folds a drag into one step. */
export type SetEdit = (fn: (edit: Edit) => Edit, mergeKey?: string) => void;

/** The Edit tab's own clock and selection, and the actions that change the cut. */
export function useEdit(edit: Edit | undefined, setEdit: SetEdit, active: boolean) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(40);

  const end = edit ? editEnd(edit) : 0;
  const timeRef = useRef(time);
  timeRef.current = time;
  /**
   * Asks the preview, live, whether a picture it needs is still loading. A
   * function rather than a flag: a held clock renders nothing, so a flag set
   * from a render would never clear.
   */
  const stalled = useRef<() => boolean>(() => false);

  // The clock: requestAnimationFrame and performance.now(), not a <video>.
  // The preview's elements follow it. While one is still seeking, time holds
  // rather than running ahead of the picture.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let waitingSince: number | null = null;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      // Wait for a seek to land, but never for long: a file that will not
      // load must not freeze the preview.
      let hold = false;
      if (stalled.current()) {
        waitingSince ??= now;
        hold = now - waitingSince < MAX_STALL_MS;
      } else {
        waitingSince = null;
      }
      const next = hold ? timeRef.current : timeRef.current + dt;
      if (next >= end) {
        timeRef.current = end;
        setTime(end);
        setPlaying(false);
        return;
      }
      timeRef.current = next;
      setTime(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, end]);

  // Leaving the tab stops playback: its sound would carry on unseen.
  useEffect(() => {
    if (!active) setPlaying(false);
  }, [active]);

  // An item that is gone (undo, delete) is no longer selected.
  useEffect(() => {
    if (selectedId && !edit?.items.some((i) => i.id === selectedId)) setSelectedId(null);
  }, [edit, selectedId]);

  const seek = useCallback(
    (t: number) => {
      const next = clamp(t, 0, Math.max(0, end));
      timeRef.current = next;
      setTime(next);
    },
    [end],
  );

  const togglePlay = useCallback(() => {
    if (!edit || end <= 0) return;
    setPlaying((p) => {
      if (!p && timeRef.current >= end - 1e-3) {
        timeRef.current = 0;
        setTime(0);
      }
      return !p;
    });
  }, [edit, end]);

  const frame = edit ? 1 / edit.canvas.fps : 1 / 30;

  const split = useCallback(() => {
    if (!edit) return;
    const t = timeRef.current;
    // The selected item if the playhead is on it, else whatever is on the main track there.
    const candidates = [
      ...edit.items.filter((i) => i.id === selectedId),
      ...trackItems(edit, MAIN_TRACK_ID),
    ];
    const target = candidates.find((i) => t > i.start && t < itemEnd(i));
    if (!target) return;
    const newId = makeId();
    setEdit((e) => splitItem(e, target.id, t, newId).edit);
    // If the split did not happen, the effect above clears this again.
    setSelectedId(newId);
  }, [edit, selectedId, setEdit]);

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    setEdit((e) => removeItem(e, selectedId));
    setSelectedId(null);
  }, [selectedId, setEdit]);

  /** Moves the selected item by whole frames; without one, steps the playhead. */
  const nudge = useCallback(
    (direction: number) => {
      const item = edit?.items.find((i) => i.id === selectedId);
      if (!item) {
        seek(timeRef.current + direction * frame);
        return;
      }
      setEdit((e) => moveItem(e, item.id, item.start + direction * frame), `nudge:${item.id}`);
    },
    [edit, selectedId, frame, seek, setEdit],
  );

  const zoomBy = useCallback((direction: number) => {
    setZoom((z) => stepZoom(z, direction > 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP));
  }, []);

  const actions = useMemo(
    () => ({
      move: (id: string, start: number, trackId: string | undefined, drag: string) =>
        setEdit((e) => moveItem(e, id, start, trackId), `drag:${drag}`),
      trimStart: (id: string, t: number, drag: string) =>
        setEdit((e) => trimItemStart(e, id, t), `drag:${drag}`),
      trimEnd: (id: string, t: number, drag: string) =>
        setEdit((e) => trimItemEnd(e, id, t), `drag:${drag}`),
      fade: (id: string, edge: "in" | "out", seconds: number, drag: string) =>
        setEdit((e) => setFade(e, id, edge, seconds), `drag:${drag}`),
      place: (sourceId: string, trackId: string, start: number) => {
        const newId = makeId();
        setEdit((e) => placeSource(e, sourceId, trackId, start, newId).edit);
        setSelectedId(newId);
      },
    }),
    [setEdit],
  );

  return {
    time,
    playing,
    end,
    zoom,
    setZoom,
    selectedId,
    setSelectedId,
    stalled,
    seek,
    togglePlay,
    pause: () => setPlaying(false),
    split,
    deleteSelected,
    nudge,
    zoomBy,
    ...actions,
  };
}

export type EditState = ReturnType<typeof useEdit>;
