import { useRef, useState } from "react";
import { clamp } from "../lib/time";

export const DEFAULT_CHAT_HEIGHT = 320;
export const MIN_CHAT_HEIGHT = 140;
export const MAX_CHAT_HEIGHT = 1000;

/** How far one arrow key moves the divider. */
const KEY_STEP = 16;

interface Props {
  height: number;
  onHeight: (height: number) => void;
}

/**
 * The divider between the Story panel and the chat below it. Dragging it up
 * makes the chat taller.
 *
 * Like `SideResizer`, it works from the pointer's delta and never measures the
 * column; `.chat-panel`'s max-height narrows the cap on a short window.
 */
export function PanelResizer({ height, onHeight }: Props) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ y: 0, height: 0 });

  const resizeTo = (next: number) =>
    onHeight(clamp(Math.round(next), MIN_CHAT_HEIGHT, MAX_CHAT_HEIGHT));

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove("resizing-rows");
    setDragging(false);
  };

  return (
    <div
      className={dragging ? "panel-resizer dragging" : "panel-resizer"}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the chat panel"
      aria-valuenow={height}
      aria-valuemin={MIN_CHAT_HEIGHT}
      aria-valuemax={MAX_CHAT_HEIGHT}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { y: e.clientY, height };
        document.body.classList.add("resizing-rows");
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        resizeTo(start.current.height - (e.clientY - start.current.y));
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onHeight(DEFAULT_CHAT_HEIGHT)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        // The editor binds the arrow keys too; while the divider has focus they
        // belong to it.
        e.preventDefault();
        e.stopPropagation();
        resizeTo(height + (e.key === "ArrowUp" ? KEY_STEP : -KEY_STEP));
      }}
    />
  );
}
