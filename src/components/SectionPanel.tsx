import { useEffect, useRef, useState } from "react";
import type { Section } from "../types";
import { formatShort } from "../lib/time";
import { sectionAt, sortSections } from "../lib/sections";

interface Props {
  sections: Section[];
  /** Playhead position, for highlighting the section it is inside. */
  currentTime: number;
  selectedId: string | null;
  /**
   * A section whose name should take focus — set when one was just created, so
   * the writer can type its name straight away.
   */
  renamingId: string | null;
  enabled: boolean;
  onAdd: () => void;
  onRename: (id: string, label: string) => void;
  /** The note Fill reads for this stretch of the timeline. */
  onNote: (id: string, note: string) => void;
  onRemove: (id: string) => void;
  onJump: (id: string) => void;
  onRenamed: () => void;
}

export function SectionPanel({
  sections,
  currentTime,
  selectedId,
  renamingId,
  enabled,
  onAdd,
  onRename,
  onNote,
  onRemove,
  onJump,
  onRenamed,
}: Props) {
  const activeId = sectionAt(sections, currentTime)?.id ?? null;
  // The panel reads in time order even while a drag has the array unsorted.
  const ordered = sortSections(sections);
  const [editingNote, setEditingNote] = useState<string | null>(null);

  return (
    <section className="panel section-panel">
      <header className="panel-header">
        <h2>Sections</h2>
        <button
          type="button"
          onClick={onAdd}
          disabled={!enabled}
          title="Flag a section at the playhead (B)"
        >
          + Add
        </button>
      </header>

      <div className="section-list">
        {ordered.length === 0 && (
          <p className="hint">
            No sections yet. Press <kbd>B</kbd> to flag one at the playhead — a cut, a
            scene, a note to yourself. Each one runs until the next.
          </p>
        )}

        {ordered.map((section) => {
          const noting = editingNote === section.id;
          const classes = ["section-row"];
          if (section.id === activeId) classes.push("active");
          if (section.id === selectedId) classes.push("selected");

          return (
            <div className={classes.join(" ")} key={section.id}>
              <button
                type="button"
                className="section-time"
                title="Jump to this section"
                onClick={() => onJump(section.id)}
              >
                {formatShort(section.start)}
              </button>

              <SectionNameInput
                value={section.label}
                autoFocus={section.id === renamingId}
                onFocused={onRenamed}
                onChange={(label) => onRename(section.id, label)}
              />

              <button
                type="button"
                className={section.note ? "icon-button has-note" : "icon-button"}
                title={section.note ? `Scene note: ${section.note}` : "Add a scene note for Fill"}
                aria-pressed={noting}
                onClick={() => setEditingNote(noting ? null : section.id)}
              >
                ✎
              </button>

              <button
                type="button"
                className="icon-button danger"
                title="Remove this section"
                onClick={() => onRemove(section.id)}
              >
                ✕
              </button>

              {noting && (
                <textarea
                  className="section-note"
                  rows={2}
                  placeholder="What is going on here — who wants what, what just changed. Fill reads this."
                  value={section.note ?? ""}
                  onChange={(e) => onNote(section.id, e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

interface NameProps {
  value: string;
  /** True for a section that was just created and is waiting to be named. */
  autoFocus: boolean;
  onFocused: () => void;
  onChange: (label: string) => void;
}

/**
 * Split out only so a newly created section can claim focus: the effect needs to
 * belong to the one row that wants it, not to the whole list.
 */
function SectionNameInput({ value, autoFocus, onFocused, onChange }: NameProps) {
  const ref = useRef<HTMLInputElement | null>(null);
  // Held in a ref so the effect below depends on `autoFocus` alone: a parent
  // re-render while the field has focus must not re-run it and re-select the
  // text out from under whoever is typing.
  const focused = useRef(onFocused);
  focused.current = onFocused;

  useEffect(() => {
    if (!autoFocus) return;
    ref.current?.focus();
    ref.current?.select();
    // Clear the request, so a later re-render does not steal focus back.
    focused.current();
  }, [autoFocus]);

  return (
    <input
      ref={ref}
      className="section-name"
      placeholder="Unnamed"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      // Typing a name must never fire an editor shortcut.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
      }}
    />
  );
}
