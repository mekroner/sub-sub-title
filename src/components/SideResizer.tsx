import { useRef, useState } from "react";
import { clamp } from "../lib/time";

export const DEFAULT_SIDE_WIDTH = 360;
export const MIN_SIDE_WIDTH = 280;
export const MAX_SIDE_WIDTH = 720;

/** How far one arrow key moves the divider. */
const KEY_STEP = 16;

interface Props {
  width: number;
  onWidth: (width: number) => void;
}

/**
 * The divider between the editing area and the side column. Dragging it left
 * widens the side column.
 *
 * The drag works from the pointer's delta rather than its absolute position, so
 * the handle never has to measure the window or the grid around it. The upper
 * bound here is a plain pixel cap; `.layout` narrows it further on a small
 * window, which is why a drag can stop short of MAX_SIDE_WIDTH.
 */
export function SideResizer({ width, onWidth }: Props) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width: 0 });

  const resizeTo = (next: number) =>
    onWidth(clamp(Math.round(next), MIN_SIDE_WIDTH, MAX_SIDE_WIDTH));

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove("resizing");
    setDragging(false);
  };

  return (
    <div
      className={dragging ? "side-resizer dragging" : "side-resizer"}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side panel"
      aria-valuenow={width}
      aria-valuemin={MIN_SIDE_WIDTH}
      aria-valuemax={MAX_SIDE_WIDTH}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width };
        document.body.classList.add("resizing");
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        resizeTo(start.current.width - (e.clientX - start.current.x));
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onWidth(DEFAULT_SIDE_WIDTH)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        // The editor binds the arrow keys too; while the divider has focus they
        // belong to it.
        e.preventDefault();
        e.stopPropagation();
        resizeTo(width + (e.key === "ArrowLeft" ? KEY_STEP : -KEY_STEP));
      }}
    />
  );
}
