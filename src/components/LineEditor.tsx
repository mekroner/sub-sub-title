import { useRef, useState } from "react";
import type { Cue, CueVoicing } from "../types";
import type { LineState, RenderedLine } from "../lib/tts";
import { DELIVERY_TAGS, SOUND_TAGS, directionIntensity, directionTags, insertTag } from "../lib/direction";
import { errorMessage } from "../lib/api";

interface Props {
  cue: Cue;
  speakerName: string;
  voicing: CueVoicing;
  /** How many cues are spoken in this cue's line, itself included. */
  groupSize: number;
  /** What the engine will be asked to say for the whole line, direction applied. */
  rendered: RenderedLine;
  state: LineState;
  /** Whether a line can be spoken right now. */
  canSpeak: boolean;
  /** Absent when no AI model is set up. */
  onSuggest?: () => Promise<string>;
  onChange: (patch: Partial<CueVoicing>) => void;
  onGenerate: () => void;
  onClose: () => void;
}

/**
 * A cue's voice script: what is spoken, tags and all, and the direction for
 * how — kept apart from the subtitle, which this never changes.
 */
export function LineEditor({
  cue,
  speakerName,
  voicing,
  groupSize,
  rendered,
  state,
  canSpeak,
  onSuggest,
  onChange,
  onGenerate,
  onClose,
}: Props) {
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const turbo = rendered.voice.engine === "turbo";
  const spoken = voicing.spoken ?? cue.text;
  const direction = voicing.direction ?? "";
  const implied = turbo ? directionTags(direction) : [];
  const intensity = turbo ? null : directionIntensity(direction);

  const addTag = (tag: string) => {
    const el = textRef.current;
    const caret = el && document.activeElement === el ? el.selectionStart : spoken.length;
    const next = insertTag(spoken, caret, tag);
    onChange({ spoken: next.text });
    // Put the caret after the tag once the new text has rendered.
    requestAnimationFrame(() => {
      const target = textRef.current;
      if (!target) return;
      target.focus();
      target.setSelectionRange(next.caret, next.caret);
    });
  };

  const suggest = async () => {
    if (!onSuggest) return;
    setSuggesting(true);
    setError(null);
    try {
      onChange({ spoken: await onSuggest() });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSuggesting(false);
    }
  };

  return (
    <section className="panel line-editor">
      <header className="panel-header">
        <h2>Voice line</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="line-editor-body">
        <div className="line-subtitle" title="The subtitle — unchanged by anything here">
          <span className="line-speaker">{speakerName}</span> {cue.text || <em>(no subtitle)</em>}
        </div>

        <label className="line-field">
          <span>Spoken</span>
          <textarea
            ref={textRef}
            rows={3}
            value={spoken}
            onChange={(e) => onChange({ spoken: e.target.value })}
            placeholder="What the voice says"
          />
        </label>
        {turbo ? (
          <div className="line-tags" aria-label="Insert a tag at the cursor">
            {SOUND_TAGS.map((tag) => (
              <button key={tag} type="button" className="tag-chip" onClick={() => addTag(tag)}>
                {tag.slice(1, -1)}
              </button>
            ))}
            <span className="line-tags-gap" />
            {DELIVERY_TAGS.filter((t) => t !== "[advertisement]").map((tag) => (
              <button
                key={tag}
                type="button"
                className="tag-chip delivery"
                onClick={() => addTag(tag)}
              >
                {tag.slice(1, -1)}
              </button>
            ))}
          </div>
        ) : (
          <p className="hint line-note">
            The Expressive model cannot perform tags; they are left out when it speaks.
          </p>
        )}

        <label className="line-field">
          <span>Direction</span>
          <input
            value={direction}
            onChange={(e) => onChange({ direction: e.target.value })}
            placeholder="e.g. whispered, out of breath"
          />
        </label>
        {direction.trim() !== "" && (
          <p className="hint line-note">
            {turbo
              ? implied.length
                ? `Adds ${implied.join(" ")}.`
                : "No tag matches this note; Suggest can work it into the line."
              : intensity !== null
                ? `Sets the intensity to ${intensity.toFixed(1)}.`
                : "Leaves the voice's intensity as it is."}
          </p>
        )}

        <div className="line-render" title="Exactly what the voice engine is asked to say">
          <span className="line-render-label">Speaks</span>
          <span>{rendered.text || <em>nothing</em>}</span>
        </div>
        {groupSize > 1 && (
          <p className="hint line-note">
            Spoken as one line with {groupSize - 1} neighbouring cue{groupSize > 2 ? "s" : ""}, so
            the sentence flows. Right-click a cue to speak it separately.
          </p>
        )}
        {state === "stale" && (
          <p className="clip-warning">The generated clip says something else; generate a new take.</p>
        )}
        {error && <p className="error">{error}</p>}

        <div className="clip-actions">
          <button
            type="button"
            className="small primary"
            disabled={!canSpeak || rendered.text === ""}
            onClick={onGenerate}
          >
            {state === "missing" ? "Generate" : "New take"}
          </button>
          <button
            type="button"
            className="small"
            disabled={!onSuggest || suggesting || direction.trim() === ""}
            onClick={() => void suggest()}
            title={
              onSuggest
                ? "Let the AI model place tags and pauses to follow the direction"
                : "Set up an AI model in Settings to use this"
            }
          >
            {suggesting ? "Suggesting…" : "✦ Suggest"}
          </button>
          <button
            type="button"
            className="small"
            disabled={voicing.spoken === undefined && voicing.direction === undefined}
            onClick={() => onChange({ spoken: undefined, direction: undefined })}
            title="Speak the subtitle as it is, with no direction"
          >
            Reset
          </button>
        </div>
      </div>
    </section>
  );
}
