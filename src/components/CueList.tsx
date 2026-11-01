import { useEffect, useLayoutEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Cue, CueIssue, Speaker } from "../types";
import { CPS_WARNING, charsPerSecond, formatShort, parseTimecode } from "../lib/time";
import { lineStats } from "../lib/text";
import { thoughtColor } from "../lib/colors";
import { issueSeverity, issueTooltip } from "../lib/issues";
import { selectModeOf, type SelectMode } from "../hooks/useCueSelection";
import type { GhostBinding } from "../hooks/useGhostCompletion";
import { GhostTextarea } from "./GhostTextarea";

interface Props {
  cues: Cue[];
  speakers: Speaker[];
  selectedIds: Set<string>;
  /** The cue single-cue commands act on; accented more strongly than the rest. */
  primaryId: string | null;
  activeCueId: string | null;
  /** Cues matching the find bar's query, highlighted in place. */
  matchIds: Set<string> | null;
  follow: boolean;
  maxCharsPerLine: number;
  maxLines: number;
  /** Spelling and grammar issues for a cue; empty while it is being re-checked. */
  issuesFor: (cue: Cue) => CueIssue[];
  /** Set when the last re-cut parked this cue, or a cut runs through it. */
  recutFlag?: (cue: Cue) => "lost" | "cut" | undefined;
  onSelect: (id: string, mode: SelectMode) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
  onSeek: (time: number) => void;
  onEditText: (id: string, text: string) => void;
  onEditTiming: (id: string, start: number, end: number) => void;
  onAssignSpeaker: (id: string, speakerId: string | null) => void;
  onToggleThought: (id: string) => void;
  /** Grey autocomplete in the focused cue. */
  ghost: GhostBinding;
}

export function CueList({
  cues,
  speakers,
  selectedIds,
  primaryId,
  activeCueId,
  matchIds,
  follow,
  maxCharsPerLine,
  maxLines,
  issuesFor,
  recutFlag,
  onSelect,
  onContextMenu,
  onSeek,
  onEditText,
  onEditTiming,
  onAssignSpeaker,
  onToggleThought,
  ghost,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: cues.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 62,
    overscan: 8,
    getItemKey: (index) => cues[index]?.id ?? index,
  });

  // Keep the playing cue on screen, and keep a keyboard-selected cue on screen.
  const activeIndex = activeCueId ? cues.findIndex((c) => c.id === activeCueId) : -1;
  const primaryIndex = primaryId ? cues.findIndex((c) => c.id === primaryId) : -1;

  useEffect(() => {
    if (!follow || activeIndex < 0) return;
    virtualizer.scrollToIndex(activeIndex, { align: "center", behavior: "smooth" });
  }, [activeIndex, follow, virtualizer]);

  useLayoutEffect(() => {
    if (primaryIndex < 0) return;
    virtualizer.scrollToIndex(primaryIndex, { align: "auto" });
  }, [primaryIndex, virtualizer]);

  if (cues.length === 0) {
    return (
      <div className="cue-list empty">
        <p>No cues yet. Import an .srt, or drag on the waveform to create one.</p>
      </div>
    );
  }

  return (
    <div className="cue-list" ref={scrollRef}>
      <div
        className="cue-list-inner"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const cue = cues[item.index];
          if (!cue) return null;
          const speaker = speakers.find((s) => s.id === cue.speakerId) ?? null;
          const cps = charsPerSecond(cue.text, cue.start, cue.end);
          const stats = lineStats(cue.text, maxCharsPerLine, maxLines);
          const issues = issuesFor(cue);
          // The badge takes the loudest severity present.
          const severity = issues.some((i) => issueSeverity(i) === "spelling")
            ? "spelling"
            : issues.some((i) => issueSeverity(i) === "grammar")
              ? "grammar"
              : "suggestion";
          const isThought = cue.mode === "thought";
          const isSelected = selectedIds.has(cue.id);
          const isPrimary = cue.id === primaryId;
          const isActive = cue.id === activeCueId;
          const isMatch = matchIds?.has(cue.id) ?? false;

          const className = [
            "cue-row",
            isSelected && "selected",
            isPrimary && "primary",
            isActive && "active",
            isMatch && "match",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className={className}
              style={{ transform: `translateY(${item.start}px)` }}
              onMouseDown={(e) => {
                // Right-click is handled by onContextMenu, which needs to know
                // whether the row was already part of the selection.
                if (e.button === 2) return;
                onSelect(cue.id, selectModeOf(e));
              }}
              onContextMenu={(e) => {
                // Inside the text and timecode fields the webview's own
                // Cut/Copy/Paste menu is the useful one.
                const target = e.target as HTMLElement;
                const tag = target.tagName;
                if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
                e.preventDefault();
                onContextMenu(cue.id, e.clientX, e.clientY);
              }}
            >
              <div className="cue-index">{item.index + 1}</div>

              <div className="cue-times">
                <TimeField
                  value={cue.start}
                  onCommit={(v) => onEditTiming(cue.id, v, cue.end)}
                />
                <TimeField
                  value={cue.end}
                  onCommit={(v) => onEditTiming(cue.id, cue.start, v)}
                />
                <button
                  type="button"
                  className="cue-jump"
                  title="Jump to this cue"
                  onClick={() => {
                    onSelect(cue.id, "replace");
                    onSeek(cue.start);
                  }}
                >
                  ▶
                </button>
              </div>

              <div className="cue-speaker">
                <span
                  className="swatch"
                  style={{
                    background: speaker
                      ? isThought
                        ? thoughtColor(speaker)
                        : speaker.color
                      : "transparent",
                  }}
                  aria-hidden
                />
                <select
                  value={cue.speakerId ?? ""}
                  onChange={(e) => onAssignSpeaker(cue.id, e.target.value || null)}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <option value="">— none —</option>
                  {speakers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={isThought ? "cue-mode on" : "cue-mode"}
                  title={
                    isThought
                      ? "Thinking — click to make it spoken (T)"
                      : "Spoken — click to make it a thought (T)"
                  }
                  aria-pressed={isThought}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => onToggleThought(cue.id)}
                >
                  💭
                </button>
              </div>

              <GhostTextarea
                cueId={cue.id}
                className={isThought ? "cue-text thought" : "cue-text"}
                value={cue.text}
                ghost={ghost.ghost?.cueId === cue.id ? ghost.ghost.text : ""}
                pending={ghost.pendingCueId === cue.id}
                binding={ghost}
                onChange={(text) => onEditText(cue.id, text)}
                onFocus={() => onSelect(cue.id, "replace")}
              />

              <div
                className={`cue-lines${stats.tooManyLines ? " too-many" : ""}`}
                title={
                  stats.tooManyLines
                    ? `${stats.lineCount} lines — at most ${maxLines} fit on screen`
                    : `Characters per line (limit ${maxCharsPerLine})`
                }
              >
                {stats.lines.map((line, i) => (
                  <span key={i} className={line.over ? "over" : undefined}>
                    {line.length}
                  </span>
                ))}
              </div>

              <div className="cue-issues">
                {recutFlag?.(cue) && (
                  <span
                    className={`issue-badge recut-${recutFlag(cue)}`}
                    title={
                      recutFlag(cue) === "lost"
                        ? "Lost in the last re-cut: its footage was cut, so it was parked after the end. Move or delete it."
                        : "A cut in the last re-cut runs through this cue: it moved with its larger part. Check its timing."
                    }
                  >
                    {recutFlag(cue) === "lost" ? "✂" : "⋯"}
                  </span>
                )}
                {issues.length > 0 && (
                  <button
                    type="button"
                    className={`issue-badge ${severity}`}
                    title={issueTooltip(issues)}
                    // Same menu the right-click gives, anchored on the badge.
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      onSelect(cue.id, "replace");
                      const box = e.currentTarget.getBoundingClientRect();
                      onContextMenu(cue.id, box.left, box.bottom);
                    }}
                  >
                    {issues.length}
                  </button>
                )}
              </div>

              <div
                className={`cue-cps${cps > CPS_WARNING ? " warn" : ""}`}
                title={`${cps.toFixed(1)} characters per second`}
              >
                {Number.isFinite(cps) ? cps.toFixed(0) : "∞"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Click-to-edit timecode. Reverts on an unparseable value. */
function TimeField({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (seconds: number) => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);

  // Keep the field in sync with waveform drags, except while it has focus.
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current) {
      ref.current.value = formatShort(value);
    }
  }, [value]);

  return (
    <input
      ref={ref}
      className="time-field"
      defaultValue={formatShort(value)}
      spellCheck={false}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          e.currentTarget.value = formatShort(value);
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => {
        const parsed = parseTimecode(e.currentTarget.value);
        if (parsed === null) {
          e.currentTarget.value = formatShort(value);
          return;
        }
        // Show the stored value again: if the commit is clamped or refused
        // outright, the field must not keep displaying what was typed. The
        // effect above replaces this as soon as the value really changes.
        e.currentTarget.value = formatShort(value);
        onCommit(parsed);
      }}
    />
  );
}
