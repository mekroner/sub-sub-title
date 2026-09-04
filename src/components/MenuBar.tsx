/**
 * An in-app menu bar. Tauri can put a real OS menu on the window, but that
 * renders in the system's light chrome and every item has to round-trip through
 * Rust; keeping the menu in the webview keeps the dark styling and lets items
 * call the same handlers the keyboard shortcuts already use.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type MenuEntry =
  | {
      kind: "item";
      label: string;
      /** Shown right-aligned, e.g. "Ctrl+S". Display only — the shortcut
       *  itself lives in `shortcutMatch`. */
      accelerator?: string;
      /** Second, dimmed line under the label — used for recent projects' paths. */
      detail?: string;
      disabled?: boolean;
      /** Renders a tick, for items that toggle a state. */
      checked?: boolean;
      onSelect: () => void;
    }
  | { kind: "submenu"; label: string; disabled?: boolean; entries: MenuEntry[] }
  | { kind: "separator" };

export interface Menu {
  label: string;
  entries: MenuEntry[];
}

interface Props {
  menus: Menu[];
  /** Lets the host suspend editor shortcuts while a menu is open. */
  onOpenChange?: (open: boolean) => void;
}

/** Moves focus between the item buttons of one open list. */
function focusSibling(list: HTMLElement | null, from: EventTarget | null, step: number) {
  if (!list) return;
  const items = Array.from(
    list.querySelectorAll<HTMLButtonElement>(":scope > li > button:not(:disabled)"),
  );
  if (items.length === 0) return;
  const index = items.indexOf(from as HTMLButtonElement);
  const next = items[(index + step + items.length) % items.length] ?? items[0];
  next.focus();
}

export function MenuBar({ menus, onOpenChange }: Props) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
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
    setOpenSubmenu(null);
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

  const renderEntries = (entries: MenuEntry[], depth: number) => (
    <ul
      className={depth === 0 ? "menu-list" : "menu-list menu-sublist"}
      role="menu"
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          focusSibling(e.currentTarget, e.target, e.key === "ArrowDown" ? 1 : -1);
        }
      }}
    >
      {entries.map((entry, i) => {
        if (entry.kind === "separator") {
          return <li key={`sep-${i}`} className="menu-separator" role="separator" />;
        }

        if (entry.kind === "submenu") {
          const expanded = openSubmenu === entry.label;
          return (
            <li
              key={entry.label}
              className="menu-parent"
              onMouseEnter={() => !entry.disabled && setOpenSubmenu(entry.label)}
            >
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={expanded}
                disabled={entry.disabled}
                onClick={() => setOpenSubmenu(expanded ? null : entry.label)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight") setOpenSubmenu(entry.label);
                  if (e.key === "ArrowLeft") setOpenSubmenu(null);
                }}
              >
                <span className="menu-label">{entry.label}</span>
                <span className="menu-accelerator">▸</span>
              </button>
              {expanded && renderEntries(entry.entries, depth + 1)}
            </li>
          );
        }

        return (
          <li key={entry.label} onMouseEnter={() => setOpenSubmenu(null)}>
            <button
              type="button"
              role="menuitem"
              disabled={entry.disabled}
              onClick={() => {
                close();
                entry.onSelect();
              }}
            >
              <span className="menu-tick">{entry.checked ? "✓" : ""}</span>
              <span className="menu-label">
                {entry.label}
                {entry.detail && <span className="menu-detail">{entry.detail}</span>}
              </span>
              {entry.accelerator && (
                <span className="menu-accelerator">{entry.accelerator}</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );

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
              setOpenSubmenu(null);
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
                setOpenSubmenu(null);
                setOpenIndex(index);
              }
            }}
          >
            {menu.label}
          </button>
          {openIndex === index && renderEntries(menu.entries, 0)}
        </div>
      ))}
    </div>
  );
}
