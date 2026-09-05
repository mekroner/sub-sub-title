/**
 * An in-app menu bar. Tauri can put a real OS menu on the window, but that
 * renders in the system's light chrome and every item has to round-trip through
 * Rust; keeping the menu in the webview keeps the dark styling and lets items
 * call the same handlers the keyboard shortcuts already use.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { MenuEntries } from "./menuEntries";
import type { Menu } from "./menuEntries";

export type { Menu, MenuEntry } from "./menuEntries";

interface Props {
  menus: Menu[];
  /** Lets the host suspend editor shortcuts while a menu is open. */
  onOpenChange?: (open: boolean) => void;
}

export function MenuBar({ menus, onOpenChange }: Props) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  /**
   * Which menu was opened by sliding onto it rather than by clicking. Without
   * this, the click that lands after a hover-switch would toggle the menu the
   * pointer just opened straight back shut.
   */
  const hoverOpened = useRef<number | null>(null);

  const close = useCallback(() => {
    hoverOpened.current = null;
    setOpenIndex(null);
  }, []);

  useEffect(() => {
    onOpenChange?.(openIndex !== null);
  }, [openIndex, onOpenChange]);

  useEffect(() => {
    if (openIndex === null) return;

    const onPointerDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Capture phase, so the editor shortcuts never see it.
        e.stopPropagation();
        close();
      }
    };

    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [openIndex, close]);

  return (
    <div className="menu-bar" ref={barRef} role="menubar">
      {menus.map((menu, index) => (
        <div key={menu.label} className="menu-root">
          <button
            type="button"
            className={openIndex === index ? "menu-title open" : "menu-title"}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={openIndex === index}
            onClick={() => {
              const justHovered = hoverOpened.current === index;
              hoverOpened.current = null;
              if (justHovered) return;
              setOpenIndex((current) => (current === index ? null : index));
            }}
            // Once one menu is open, sliding across the bar switches menus,
            // the way a desktop menu bar behaves.
            onMouseEnter={() => {
              if (openIndex !== null && openIndex !== index) {
                hoverOpened.current = index;
                setOpenIndex(index);
              }
            }}
          >
            {menu.label}
          </button>
          {openIndex === index && <MenuEntries entries={menu.entries} onClose={close} />}
        </div>
      ))}
    </div>
  );
}
