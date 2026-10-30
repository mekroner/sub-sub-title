import { useEffect, useRef, useState } from "react";
import type { Section, TimedBeat } from "../types";
import { formatShort, parseTimecode } from "../lib/time";
import { sectionAt } from "../lib/sections";
import { groupBySection, newBeat, type BeatGroup } from "../lib/timedBeats";

type Tab = "sections" | "brief";

interface Props {
  /** Premise, tone, world — what Fill, the chat and the agents read first. */
  brief: string;
  onBriefChange: (brief: string) => void;
  sections: Section[];
  timedBeats: TimedBeat[];
  /** Seconds; 0 while no video is loaded. */
  duration: number;
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
  onSeek: (time: number) => void;
  onAddBeat: (beat: TimedBeat) => void;
  onEditBeat: (id: string, patch: { time?: number; text?: string }) => void;
  onRemoveBeat: (id: string) => void;
  /** Starts a story run: puts `/story` into the chat box. */
  onStory: () => void;
}

/** The key a group is opened by: its section, or the stretch before the first. */
const groupKey = (group: BeatGroup) => group.section?.id ?? "before";

/** The story side of the project: sections with their notes and beats, and the brief. */
export function StoryPanel({
  brief,
  onBriefChange,
  sections,
  timedBeats,
  duration,
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
  onSeek,
  onAddBeat,
  onEditBeat,
  onRemoveBeat,
  onStory,
}: Props) {
  const activeId = sectionAt(sections, currentTime)?.id ?? null;
  // Grouped in time order, which also reads right while a drag has the
  // section array unsorted.
  const groups = groupBySection(sections, timedBeats, duration);
  const [open, setOpen] = useState<Set<string>>(new Set());
  /** A beat just added, whose text should take focus. */
  const [focusBeat, setFocusBeat] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("sections");

  // A section just flagged (B, the timeline menu) wants its name typed, which
  // only works with the list showing.
  useEffect(() => {
    if (renamingId) setTab("sections");
  }, [renamingId]);

  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const addBeatIn = (group: BeatGroup) => {
    const inside = currentTime >= group.start && currentTime < group.end;
    const beat = newBeat(inside ? currentTime : group.start);
    onAddBeat(beat);
    setFocusBeat(beat.id);
    setOpen((current) => new Set(current).add(groupKey(group)));
  };

  return (
    <section className="panel story-panel">
      <header className="panel-header">
        <h2>Story</h2>
        <div className="segmented story-tabs" role="tablist" aria-label="Story">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "sections"}
            className={tab === "sections" ? "small on" : "small"}
            onClick={() => setTab("sections")}
          >
            Sections
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "brief"}
            className={tab === "brief" ? "small on" : "small"}
            onClick={() => setTab("brief")}
          >
            Brief
          </button>
        </div>
        <span className="story-actions">
          <button
            type="button"
            className="small"
            onClick={onStory}
            title="Let the story agent work on the outline — puts /story into the chat"
          >
            ✦ Story
          </button>
          {tab === "sections" && (
            <button
              type="button"
              onClick={onAdd}
              disabled={!enabled}
              title="Flag a section at the playhead (B)"
            >
              + Add
            </button>
          )}
        </span>
      </header>

      {tab === "brief" ? (
        <div className="story-brief" role="tabpanel">
          <textarea
            aria-label="Project brief"
            value={brief}
            placeholder="Premise, tone, world — e.g. A dry Nordic comedy. Anna and Ben run a failing ferry café; neither will admit they want out."
            onChange={(e) => onBriefChange(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <p className="hint">Fill, the chat, /continue and /story all read this first.</p>
        </div>
      ) : (
        <div className="section-list" role="tabpanel">
          {sections.length === 0 && (
            <p className="hint">
              No sections yet. Press <kbd>B</kbd> to flag one at the playhead — a cut, a
              scene, a note to yourself. Each one runs until the next.
            </p>
          )}

          {groups.map((group) => {
            const key = groupKey(group);
            const expanded = open.has(key);
            const section = group.section;
            const classes = ["section-row"];
            if (section && section.id === activeId) classes.push("active");
            if (section && section.id === selectedId) classes.push("selected");
            if (!section) classes.push("before");

            return (
              <div className="section-group" key={key}>
                <div className={classes.join(" ")}>
                  <button
                    type="button"
                    className="icon-button section-toggle"
                    aria-expanded={expanded}
                    title={expanded ? "Hide the note and beats" : "Show the note and beats"}
                    onClick={() => toggle(key)}
                  >
                    {expanded ? "▾" : "▸"}
                  </button>

                  {section ? (
                    <>
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
                    </>
                  ) : (
                    <span className="section-before">
                      {sections.length === 0 ? "Whole video" : "Before the first section"}
                    </span>
                  )}

                  <span
                    className={section?.note ? "section-badge has-note" : "section-badge"}
                    title={
                      `${group.beats.length} ${group.beats.length === 1 ? "beat" : "beats"}` +
                      (section?.note ? " · has a scene note" : "")
                    }
                  >
                    {group.beats.length > 0 ? group.beats.length : ""}
                    {section?.note ? "✎" : ""}
                  </span>

                  {section ? (
                    <button
                      type="button"
                      className="icon-button danger"
                      title="Remove this section (its beats stay)"
                      onClick={() => onRemove(section.id)}
                    >
                      ✕
                    </button>
                  ) : (
                    <span />
                  )}
                </div>

                {expanded && (
                  <div className="section-body">
                    {section && (
                      <textarea
                        className="section-note"
                        rows={2}
                        placeholder="What is going on here — who wants what, what just changed. Fill and /continue read this."
                        value={section.note ?? ""}
                        onChange={(e) => onNote(section.id, e.target.value)}
                        onKeyDown={(e) => e.stopPropagation()}
                      />
                    )}

                    {group.beats.map((beat) => (
                      <BeatRow
                        key={beat.id}
                        beat={beat}
                        autoFocus={beat.id === focusBeat}
                        onFocused={() => setFocusBeat(null)}
                        onSeek={onSeek}
                        onEdit={(patch) => onEditBeat(beat.id, patch)}
                        onRemove={() => onRemoveBeat(beat.id)}
                      />
                    ))}

                    <button
                      type="button"
                      className="small section-add-beat"
                      onClick={() => addBeatIn(group)}
                      title="Add a story beat at the playhead, or at the start of this section"
                    >
                      + Beat
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

interface BeatProps {
  beat: TimedBeat;
  autoFocus: boolean;
  onFocused: () => void;
  onSeek: (time: number) => void;
  onEdit: (patch: { time?: number; text?: string }) => void;
  onRemove: () => void;
}

/**
 * One timed beat. Clicking the time jumps there and opens it for editing;
 * Enter keeps the new time, Esc or an unreadable time puts the old one back.
 */
function BeatRow({ beat, autoFocus, onFocused, onSeek, onEdit, onRemove }: BeatProps) {
  const [timeDraft, setTimeDraft] = useState<string | null>(null);
  const textRef = useRef<HTMLInputElement | null>(null);
  const focused = useRef(onFocused);
  focused.current = onFocused;

  useEffect(() => {
    if (!autoFocus) return;
    textRef.current?.focus();
    focused.current();
  }, [autoFocus]);

  const commitTime = () => {
    if (timeDraft === null) return;
    const time = parseTimecode(timeDraft);
    if (time !== null && Number.isFinite(time)) onEdit({ time });
    setTimeDraft(null);
  };

  return (
    <div className={beat.by === "agent" ? "beat-row agent" : "beat-row"}>
      {timeDraft === null ? (
        <button
          type="button"
          className="beat-time"
          title="Jump here; click again to change the time"
          onClick={() => {
            onSeek(beat.time);
            setTimeDraft(formatShort(beat.time));
          }}
        >
          {formatShort(beat.time)}
        </button>
      ) : (
        <input
          className="beat-time-input"
          autoFocus
          value={timeDraft}
          aria-label="Beat time"
          onChange={(e) => setTimeDraft(e.target.value)}
          onBlur={commitTime}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commitTime();
            if (e.key === "Escape") setTimeDraft(null);
          }}
        />
      )}
      <input
        ref={textRef}
        className="beat-text"
        value={beat.text}
        placeholder="What happens here"
        title={beat.by === "agent" ? "Written by the story agent — editing it makes it yours" : undefined}
        onChange={(e) => onEdit({ text: e.target.value })}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
        }}
      />
      <span className="beat-owner" title={beat.by === "agent" ? "Written by the story agent" : "Yours"}>
        {beat.by === "agent" ? "✦" : ""}
      </span>
      <button type="button" className="icon-button danger" title="Remove this beat" onClick={onRemove}>
        ✕
      </button>
    </div>
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
