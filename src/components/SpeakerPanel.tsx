import { useState } from "react";
import type { Cue, Speaker } from "../types";
import { contrastText } from "../lib/colors";
import { detectSpeakerPrefixes } from "../lib/srt";
import { ColorPicker } from "./ColorPicker";

interface Props {
  speakers: Speaker[];
  cues: Cue[];
  /** How many cues the assign buttons would tag. */
  selectedCount: number;
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<Speaker>) => void;
  onRemove: (id: string) => void;
  onAssignToSelected: (speakerId: string) => void;
  onApplyDetected: (names: string[]) => void;
}

export function SpeakerPanel({
  speakers,
  cues,
  selectedCount,
  onAdd,
  onUpdate,
  onRemove,
  onAssignToSelected,
  onApplyDetected,
}: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const detected = detectSpeakerPrefixes(cues);
  const untagged = cues.filter((c) => !c.speakerId).length;

  return (
    <section className="panel speaker-panel">
      <header className="panel-header">
        <h2>Speakers</h2>
        <button type="button" onClick={onAdd} title="Add a speaker">
          + Add
        </button>
      </header>

      <div className="speaker-list">
        {speakers.length === 0 && (
          <p className="hint">
            No speakers yet. Add one, then press <kbd>1</kbd>–<kbd>9</kbd> to tag the
            selected cue.
          </p>
        )}

        {speakers.map((speaker, index) => {
          const count = cues.filter((c) => c.speakerId === speaker.id).length;
          const isEditing = editing === speaker.id;

          return (
            <div className="speaker-row" key={speaker.id}>
              <button
                type="button"
                className="speaker-key"
                style={{
                  background: speaker.color,
                  color: contrastText(speaker.color),
                }}
                title={
                  selectedCount > 0
                    ? `Assign ${speaker.name} to ${
                        selectedCount === 1 ? "the selected cue" : `${selectedCount} cues`
                      }`
                    : "Select a cue first"
                }
                disabled={selectedCount === 0}
                onClick={() => onAssignToSelected(speaker.id)}
              >
                {index < 9 ? index + 1 : "•"}
              </button>

              <div className="speaker-main">
                <input
                  className="speaker-name"
                  value={speaker.name}
                  onChange={(e) => onUpdate(speaker.id, { name: e.target.value })}
                  onKeyDown={(e) => e.stopPropagation()}
                />
                <span className="speaker-count">
                  {count} {count === 1 ? "line" : "lines"}
                </span>
              </div>

              <ColorPicker
                value={speaker.color}
                inUse={speakers.filter((s) => s.id !== speaker.id).map((s) => s.color)}
                title={`Caption colour for ${speaker.name}`}
                onChange={(color) => onUpdate(speaker.id, { color })}
              />

              <button
                type="button"
                className="icon-button"
                title="Voice notes for the continue-feature"
                aria-pressed={isEditing}
                onClick={() => setEditing(isEditing ? null : speaker.id)}
              >
                ✎
              </button>

              <button
                type="button"
                className="icon-button danger"
                title="Remove this speaker"
                onClick={() => onRemove(speaker.id)}
              >
                ✕
              </button>

              {isEditing && (
                <textarea
                  className="voice-notes"
                  placeholder={`How does ${speaker.name} speak? Tone, vocabulary, quirks — used by the continue-feature.`}
                  value={speaker.voiceNotes ?? ""}
                  rows={3}
                  onChange={(e) => onUpdate(speaker.id, { voiceNotes: e.target.value })}
                  onKeyDown={(e) => e.stopPropagation()}
                />
              )}
            </div>
          );
        })}
      </div>

      <footer className="panel-footer">
        <span className="hint">
          {cues.length === 0
            ? "No cues loaded"
            : untagged > 0
              ? `${untagged} cue${untagged === 1 ? "" : "s"} untagged`
              : "All cues tagged"}
        </span>

        {detected.length > 0 && (
          <button
            type="button"
            className="detect-button"
            title={`Found ${detected
              .map((d) => `${d.name} (${d.count})`)
              .join(", ")} as inline prefixes`}
            onClick={() => onApplyDetected(detected.map((d) => d.name))}
          >
            Detect {detected.length} from “NAME:” prefixes
          </button>
        )}
      </footer>
    </section>
  );
}
