import { useEffect, useRef, useState } from "react";

import { projectName } from "../lib/projectFile";
import type { RecentProject } from "../types";

interface Props {
  projects: RecentProject[];
  /** Highlighted in the list, and not worth reopening. */
  currentPath: string | null;
  onPick: (path: string) => void;
}

export function RecentMenu({ projects, currentPath, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };

    window.addEventListener("mousedown", onPointerDown);
    // Capture, so Escape closes the menu before the editor shortcuts see it.
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <div className="recent-menu" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={projects.length === 0}
        title={
          projects.length === 0 ? "No projects opened yet" : "Recently opened projects"
        }
      >
        Recent ▾
      </button>
      {open && (
        <ul className="recent-list">
          {projects.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className={entry.path === currentPath ? "recent-item current" : "recent-item"}
                title={entry.path}
                onClick={() => {
                  setOpen(false);
                  if (entry.path !== currentPath) onPick(entry.path);
                }}
              >
                <span className="recent-name">{projectName(entry.path)}</span>
                <span className="recent-path">{entry.path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
