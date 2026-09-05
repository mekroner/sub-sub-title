/**
 * The entry model and rendering shared by the menu bar and the right-click
 * menu, so an item looks and behaves the same wherever it is invoked from.
 */

import { useState } from "react";

export type MenuEntry =
  | {
      kind: "item";
      label: string;
      /** Shown right-aligned, e.g. "Ctrl+S". Display only — the shortcut
       *  itself lives in `shortcutMatch`. */
      accelerator?: string;
      /** Second, dimmed line under the label. */
      detail?: string;
      /** Ellipsise the detail from the *left*, so a path's filename stays visible. */
      detailIsPath?: boolean;
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

/** Moves focus between the item buttons of one open list. */
export function focusSibling(
  list: HTMLElement | null,
  from: EventTarget | null,
  step: number,
) {
  if (!list) return;
  const items = Array.from(
    list.querySelectorAll<HTMLButtonElement>(":scope > li > button:not(:disabled)"),
  );
  if (items.length === 0) return;
  const index = items.indexOf(from as HTMLButtonElement);
  const next = items[(index + step + items.length) % items.length] ?? items[0];
  next.focus();
}

interface Props {
  entries: MenuEntry[];
  /** 0 is a top-level list; deeper lists render as flyouts. */
  depth?: number;
  /** Closes the whole menu once an item has run. */
  onClose: () => void;
  className?: string;
  style?: React.CSSProperties;
}

export function MenuEntries({ entries, depth = 0, onClose, className, style }: Props) {
  // One open flyout per level; the state dies with the list when it unmounts.
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);

  const classes = [depth === 0 ? "menu-list" : "menu-list menu-sublist", className]
    .filter(Boolean)
    .join(" ");

  return (
    <ul
      className={classes}
      style={style}
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
              {expanded && (
                <MenuEntries entries={entry.entries} depth={depth + 1} onClose={onClose} />
              )}
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
                onClose();
                entry.onSelect();
              }}
            >
              <span className="menu-tick">{entry.checked ? "✓" : ""}</span>
              <span className="menu-label">
                {entry.label}
                {entry.detail && (
                  <span className={entry.detailIsPath ? "menu-detail path" : "menu-detail"}>
                    {entry.detail}
                  </span>
                )}
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
}
