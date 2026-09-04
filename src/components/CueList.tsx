import { useEffect, useLayoutEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Cue, Speaker } from "../types";
import { charsPerSecond, formatShort, parseTimecode } from "../lib/time";

interface Props {
  cues: Cue[];
  speakers: Speaker[];
  selectedCueId: string | null;
  activeCueId: string | null;
  follow: boolean;
  onSelect: (id: string) => void;
  onSeek: (time: number) => void;
  onEditText: (id: string, text: string) => void;
  onEditTiming: (id: string, start: number, end: number) => void;
  onAssignSpeaker: (id: string, speakerId: string | null) => void;
}

/** Above this characters-per-second a caption is hard to read; flag it. */
const CPS_WARNING = 21;

export function CueList({
  cues,
  speakers,
  selectedCueId,
  activeCueId,
  follow,
  onSelect,
  onSeek,
  onEditText,
  onEditTiming,
  onAssignSpeaker,
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
  const selectedIndex = selectedCueId ? cues.findIndex((c) => c.id === selectedCueId) : -1;

  useEffect(() => {
    if (!follow || activeIndex < 0) return;
    virtualizer.scrollToIndex(activeIndex, { align: "center", behavior: "smooth" });
  }, [activeIndex, follow, virtualizer]);

  useLayoutEffect(() => {
    if (selectedIndex < 0) return;
    virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
  }, [selectedIndex, virtualizer]);

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
          const isSelected = cue.id === selectedCueId;
          const isActive = cue.id === activeCueId;

          return (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className={`cue-row${isSelected ? " selected" : ""}${
                isActive ? " active" : ""
              }`}
              style={{ transform: `translateY(${item.start}px)` }}
              onMouseDown={() => onSelect(cue.id)}
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
                    onSelect(cue.id);
                    onSeek(cue.start);
                  }}
                >
                  ▶
                </button>
              </div>

              <div className="cue-speaker">
                <span
                  className="swatch"
                  style={{ background: speaker?.color ?? "transparent" }}
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
              </div>

              <textarea
                className="cue-text"
                value={cue.text}
                rows={Math.min(4, cue.text.split("\n").length || 1)}
                spellCheck={false}
                onChange={(e) => onEditText(cue.id, e.target.value)}
                onFocus={() => onSelect(cue.id)}
                // Let the textarea own its keys; the global shortcuts must not
                // steal Space, digits, arrows or Enter while typing.
                onKeyDown={(e) => e.stopPropagation()}
              />

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
        onCommit(parsed);
      }}
    />
  );
}
