/**
 * A swatch that opens a small palette. The native colour input is still there
 * under "Custom", but picking a speaker colour is almost always reaching for
 * one of nine known-good hues or one used recently, and the OS dialog is a slow
 * way to do that.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SPEAKER_PALETTE, contrastText } from "../lib/colors";

const STORAGE_KEY = "sub-sub-title:recent-colors";
const RECENT_LIMIT = 8;

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is string => typeof c === "string").slice(0, RECENT_LIMIT);
  } catch {
    // Blocked site data, or a value written by an older build.
    return [];
  }
}

/** Exported so a colour chosen anywhere else can join the list too. */
export function rememberColor(color: string): string[] {
  const next = [color, ...readRecent().filter((c) => c.toLowerCase() !== color.toLowerCase())]
    .slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A lost preference is not worth interrupting an edit session.
  }
  return next;
}

interface Props {
  value: string;
  onChange: (color: string) => void;
  /** Colours already in use in this project, offered before the palette. */
  inUse?: string[];
  title?: string;
}

export function ColorPicker({ value, onChange, inUse = [], title }: Props) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>(readRecent);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // The speaker list scrolls, so the panel is portalled to the body and
  // positioned against the swatch rather than nested inside the clipped row.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = rootRef.current?.getBoundingClientRect();
    const panel = popoverRef.current?.getBoundingClientRect();
    if (!anchor || !panel) return;
    setPosition({
      left: Math.max(6, Math.min(anchor.right - panel.width, window.innerWidth - panel.width - 6)),
      top:
        anchor.bottom + panel.height + 6 > window.innerHeight
          ? Math.max(6, anchor.top - panel.height - 4)
          : anchor.bottom + 4,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setRecent(readRecent());

    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const pick = (color: string, close = true) => {
    onChange(color);
    setRecent(rememberColor(color));
    if (close) setOpen(false);
  };

  const others = inUse.filter((c) => c.toLowerCase() !== value.toLowerCase());

  const swatches = (colors: string[], label: string) => (
    <div className="swatch-row" role="group" aria-label={label}>
      {colors.map((color) => (
        <button
          key={`${label}-${color}`}
          type="button"
          className={
            color.toLowerCase() === value.toLowerCase() ? "swatch-button current" : "swatch-button"
          }
          style={{ background: color, color: contrastText(color) }}
          title={color}
          onClick={() => pick(color)}
        >
          {color.toLowerCase() === value.toLowerCase() ? "✓" : ""}
        </button>
      ))}
    </div>
  );

  return (
    <div className="color-picker" ref={rootRef}>
      <button
        type="button"
        className="color-swatch"
        style={{ background: value }}
        title={title ?? "Caption colour"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      />

      {open &&
        createPortal(
        <div
          className="color-popover"
          role="dialog"
          ref={popoverRef}
          style={{ left: position.left, top: position.top }}
        >
          <span className="color-heading">Palette</span>
          {swatches(SPEAKER_PALETTE, "Palette")}

          {others.length > 0 && (
            <>
              <span className="color-heading">In this project</span>
              {swatches(others, "In this project")}
            </>
          )}

          {recent.length > 0 && (
            <>
              <span className="color-heading">Recent</span>
              {swatches(recent, "Recent")}
            </>
          )}

          <label className="color-custom">
            <span>Custom</span>
            <input
              type="color"
              value={value}
              // Dragging in the OS picker fires change repeatedly; keep the
              // popover open so the result stays visible while choosing.
              onChange={(e) => pick(e.target.value, false)}
            />
          </label>
        </div>,
          document.body,
        )}
    </div>
  );
}
