/**
 * The named-section strip under the waveform.
 *
 * Sections are point markers: each one owns the span from its own start to the
 * next one's, so the lane reads as a contiguous run of labelled blocks.
 *
 * Alignment is the whole job, and it is why nothing here derives pixels from
 * the `zoom` prop: wavesurfer stretches the waveform to fill the pane whenever
 * the timeline is narrower than the container, so the real pixels-per-second is
 * not the zoom the app asked for. Instead one inner element is sized and offset
 * to sit exactly on wavesurfer's scroll content, and the blocks inside it are
 * placed in percent-of-duration — the same units the regions plugin uses for
 * cues, so a section edge and a cue edge at the same instant land on the same
 * pixel at every zoom level.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Section } from "../types";
import { clamp } from "../lib/time";
import { sectionSpans } from "../lib/sections";

interface Props {
  /** wavesurfer's scroll content (`ws.getWrapper()`), or null before it exists. */
  wrapper: HTMLElement | null;
  /** The duration the cue regions are positioned against. See WaveformPane. */
  duration: number;
  sections: Section[];
  selectedId: string | null;
  onSeek: (time: number) => void;
  onSelect: (id: string) => void;
  /** Called once, on release, with the dragged section's new start. */
  onMove: (id: string, start: number) => void;
  onContextMenuSection: (id: string, x: number, y: number) => void;
  /** Right-click on empty lane: the instant under the pointer, and the anchor. */
  onContextMenuEmpty: (time: number, x: number, y: number) => void;
}

/** Movement, in px, before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD = 3;

interface DragState {
  id: string;
  pointerId: number;
  /** Where the pointer went down, to measure the threshold against. */
  originX: number;
  /** Seconds between the grab point and the block's start, so it never jumps. */
  grab: number;
  /** Live position, rendered in place of the section's own start. */
  time: number;
  /** False until the threshold is passed; a press that never moves is a click. */
  moved: boolean;
}

export function SectionLane({
  wrapper,
  duration,
  sections,
  selectedId,
  onSeek,
  onSelect,
  onMove,
  onContextMenuSection,
  onContextMenuEmpty,
}: Props) {
  const laneRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  // Latest props for the pointer path, which reads them outside a render.
  const latest = useRef({ duration, sections, onSeek, onSelect, onMove });
  latest.current = { duration, sections, onSeek, onSelect, onMove };

  // --- Alignment ----------------------------------------------------------

  /**
   * Park the inner element exactly where wavesurfer's scroll content is.
   *
   * Both rects are read before either style is written: at scroll and
   * resize-observer time the layout is already clean, so the reads are free,
   * but a write between them would force a reflow on every frame.
   */
  const sync = useCallback(() => {
    const lane = laneRef.current;
    const inner = innerRef.current;
    if (!lane || !inner || !wrapper) return;

    const content = wrapper.getBoundingClientRect();
    const box = lane.getBoundingClientRect();
    // Before the first render the wrapper has no width. Leave the last good
    // geometry in place rather than collapsing the lane to nothing.
    if (content.width <= 0) return;

    const width = `${content.width}px`;
    // Subpixel, and it absorbs everything between the two left edges: the
    // scroll offset, and any inline padding wavesurfer applies to its scroller.
    const transform = `translateX(${content.left - box.left}px)`;
    if (inner.style.width !== width) inner.style.width = width;
    if (inner.style.transform !== transform) inner.style.transform = transform;
  }, [wrapper]);

  useLayoutEffect(() => {
    if (!wrapper) return;
    // The scroll container inside wavesurfer's shadow root.
    const scroller = wrapper.parentElement;
    if (!scroller) return;

    sync();

    // Panning, wheel scrolling and autoScroll during playback all land here: a
    // programmatic scrollLeft write queues a scroll event too, and the scroll
    // steps run before paint, so the lane moves in the same frame the waveform
    // repaints in.
    scroller.addEventListener("scroll", sync, { passive: true });

    // Zooming does not reliably emit a scroll event — reRender only nudges
    // scrollLeft when the content was already scrollable and its width actually
    // changed — but it always rewrites the wrapper's width, so watch that box.
    // The scroller is watched too, for pane resizes: those reach the wrapper
    // only through wavesurfer's own debounced observer, a frame or two later.
    const observer = new ResizeObserver(sync);
    observer.observe(wrapper);
    observer.observe(scroller);

    return () => {
      scroller.removeEventListener("scroll", sync);
      observer.disconnect();
    };
  }, [wrapper, sync]);

  // --- Hit testing --------------------------------------------------------

  /**
   * The inverse of how everything in this lane is positioned. Reads a fresh
   * rect: pointer events are rare enough that the measurement is free, and it
   * stays correct even if the view moved since the last sync.
   */
  const timeAt = useCallback(
    (clientX: number): number | null => {
      const total = latest.current.duration;
      if (!wrapper || total <= 0) return null;
      const rect = wrapper.getBoundingClientRect();
      if (rect.width <= 0) return null;
      return clamp(((clientX - rect.left) / rect.width) * total, 0, total);
    },
    [wrapper],
  );

  // --- Drag ---------------------------------------------------------------

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>, section: Section) => {
    if (event.button !== 0) return;
    const time = timeAt(event.clientX);
    if (time === null) return;
    // Capture on the block itself: the lane is a thin strip, and a drag that
    // strays out of it has to keep delivering moves.
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      id: section.id,
      pointerId: event.pointerId,
      originX: event.clientX,
      grab: time - section.start,
      time: section.start,
      moved: false,
    });
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const time = timeAt(event.clientX);
    if (time === null) return;
    const moved = drag.moved || Math.abs(event.clientX - drag.originX) > DRAG_THRESHOLD;
    // Below the threshold the block stays exactly where it was, so a shaky
    // click does not visibly nudge it before turning out to be a click.
    const next = clamp(time - drag.grab, 0, latest.current.duration);
    setDrag((d) =>
      d && d.pointerId === event.pointerId
        ? { ...d, moved, time: moved ? next : d.time }
        : d,
    );
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDrag(null);

    // Click versus drag is decided here, so there is no click handler for a
    // finished drag to set off — which is the whole class of bug the regions
    // plugin has to swallow a trailing click to avoid.
    if (drag.moved) {
      latest.current.onMove(drag.id, drag.time);
      return;
    }
    const section = latest.current.sections.find((s) => s.id === drag.id);
    if (!section) return;
    latest.current.onSelect(section.id);
    latest.current.onSeek(section.start);
  };

  const onPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    // A cancelled gesture abandons the move; nothing was committed on the way.
    if (drag && event.pointerId === drag.pointerId) setDrag(null);
  };

  // --- Spans --------------------------------------------------------------

  const placeable = Boolean(wrapper) && duration > 0;

  /**
   * Each section's span, keyed by id, with the dragged one's live position
   * folded in — so pushing a block past its neighbour re-flows both as it
   * happens, from the same code path that produces the committed result.
   */
  const spans = useMemo(() => {
    if (!placeable) return new Map<string, { start: number; end: number }>();
    const live =
      drag && drag.moved
        ? sections.map((s) => (s.id === drag.id ? { ...s, start: drag.time } : s))
        : sections;
    return new Map(
      sectionSpans(live, duration).map((s) => [s.id, { start: s.start, end: s.end }]),
    );
  }, [sections, drag, placeable, duration]);

  return (
    <div
      className="section-lane"
      ref={laneRef}
      onContextMenu={(event) => {
        event.preventDefault();
        const time = timeAt(event.clientX);
        if (time === null) return;
        onContextMenuEmpty(time, event.clientX, event.clientY);
      }}
    >
      <div className="section-lane-inner" ref={innerRef}>
        {/*
          Rendered in the sections array's own order rather than sorted: the
          blocks are absolutely positioned, so DOM order does not affect where
          they land, and keeping it stable means a block's node is never moved
          mid-drag, which would put its pointer capture at risk.
        */}
        {sections.map((section) => {
          const span = spans.get(section.id);
          if (!span) return null;
          const dragging = drag?.id === section.id && drag.moved;
          const classes = ["section-marker"];
          if (section.id === selectedId) classes.push("selected");
          if (dragging) classes.push("dragging");
          return (
            <div
              key={section.id}
              className={classes.join(" ")}
              title={section.label || "Unnamed section"}
              style={{
                left: `${(span.start / duration) * 100}%`,
                right: `${((duration - span.end) / duration) * 100}%`,
              }}
              onPointerDown={(event) => onPointerDown(event, section)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onContextMenuSection(section.id, event.clientX, event.clientY);
              }}
            >
              <span className="section-label">{section.label}</span>
            </div>
          );
        })}
      </div>
      {placeable && sections.length === 0 && (
        <span className="section-lane-hint">Press B to flag a section</span>
      )}
    </div>
  );
}
