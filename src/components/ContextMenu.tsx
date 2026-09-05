/**
 * A right-click menu, anchored at the pointer. It renders the same entries the
 * menu bar does, so a command looks identical wherever it is reached from.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MenuEntries } from "./menuEntries";
import type { MenuEntry } from "./menuEntries";

export interface ContextMenuState {
  x: number;
  y: number;
  entries: MenuEntry[];
}

interface Props {
  state: ContextMenuState;
  onClose: () => void;
}

/** Keeps the panel on screen when the click lands near an edge. */
const MARGIN = 6;
/** `.menu-list`'s min-width: what a flyout needs to the side of its parent. */
const SUBMENU_WIDTH = 230;

export function ContextMenu({ state, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: state.x, top: state.y });
  /** Flyouts open leftwards when there is no room for them on the right. */
  const [flipSubmenus, setFlipSubmenus] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left =
      state.x + width + MARGIN > window.innerWidth
        ? Math.max(MARGIN, state.x - width)
        : state.x;
    setPosition({
      left,
      top:
        state.y + height + MARGIN > window.innerHeight
          ? Math.max(MARGIN, window.innerHeight - height - MARGIN)
          : state.y,
    });
    setFlipSubmenus(left + width + SUBMENU_WIDTH > window.innerWidth);
  }, [state]);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Capture phase, so the editor shortcuts never see it.
        e.stopPropagation();
        onClose();
      }
    };

    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    // Anything that moves the anchor out from under the menu closes it.
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    window.addEventListener("wheel", onClose, { passive: true });
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("wheel", onClose);
    };
  }, [onClose]);

  return (
    <div
      className={flipSubmenus ? "context-menu flip-submenus" : "context-menu"}
      ref={ref}
      style={{ left: position.left, top: position.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuEntries entries={state.entries} onClose={onClose} />
    </div>
  );
}
