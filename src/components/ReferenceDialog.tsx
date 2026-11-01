import { useMemo, useState } from "react";
import type { Cue } from "../types";
import { errorMessage } from "../lib/api";
import { formatShort } from "../lib/time";
import { REFERENCE_MAX_SECONDS, speechText } from "../lib/tts";
import { ReferenceAmount, TemplateOption, templateName, type TemplateChoice } from "./ReferenceParts";

interface Props {
  speakerName: string;
  /** What a template made from this voice is called unless renamed. */
  templateDefault: string;
  /** Every cue of the speaker, in time order. */
  cues: Cue[];
  /** Ticked when the dialog opens: the last choice, or a suggestion. */
  initial: Set<string>;
  /** The cue whose stretch of video is playing, if any. */
  playingId: string | null;
  onPlay: (cue: Cue) => void;
  onStop: () => void;
  /** `template` names the voice template to keep it as, if any. */
  onBuild: (chosen: Cue[], template: string | null) => Promise<void>;
  onClose: () => void;
}

/**
 * Choosing which of a speaker's cues to clone their voice from. A cue is only
 * a guess at where the speaker talks — it may sit over music, another voice,
 * or nobody — so the cues are offered for listening and picking, not taken.
 */
export function ReferenceDialog({
  speakerName,
  templateDefault,
  cues,
  initial,
  playingId,
  onPlay,
  onStop,
  onBuild,
  onClose,
}: Props) {
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [template, setTemplate] = useState<TemplateChoice>({ save: false, name: templateDefault });

  const picked = useMemo(() => cues.filter((c) => chosen.has(c.id)), [cues, chosen]);
  const total = picked.reduce((sum, c) => sum + (c.end - c.start), 0);
  const used = Math.min(total, REFERENCE_MAX_SECONDS);

  const toggle = (id: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const build = async () => {
    setBusy(true);
    setError(null);
    onStop();
    try {
      await onBuild(picked, templateName(template));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    onStop();
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : close}>
      <div
        className="modal reference-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" && !busy) close();
        }}
      >
        <header className="modal-header">
          <h2>Clone {speakerName}'s voice</h2>
          {!busy && (
            <button type="button" className="icon-button" onClick={close}>
              ✕
            </button>
          )}
        </header>

        <div className="modal-body">
          <p className="hint">
            Tick the cues where {speakerName} is clearly speaking, alone, without other voices over
            them. Listen with ▶. Music and effects are taken out, the cleanest lines are put
            first and lines that are mostly music are left out, but a few clean lines still beat
            many noisy ones.
          </p>

          <div className="reference-list">
            {cues.length === 0 && <p className="hint">This speaker has no cues.</p>}
            {cues.map((cue) => (
              <label
                key={cue.id}
                className={chosen.has(cue.id) ? "reference-row chosen" : "reference-row"}
              >
                <input
                  type="checkbox"
                  checked={chosen.has(cue.id)}
                  onChange={() => toggle(cue.id)}
                  disabled={busy}
                />
                <button
                  type="button"
                  className="icon-button"
                  onClick={(e) => {
                    // Inside the label: without this the click would also tick it.
                    e.preventDefault();
                    if (playingId === cue.id) onStop();
                    else onPlay(cue);
                  }}
                  title={playingId === cue.id ? "Stop" : "Listen to this stretch of the video"}
                >
                  {playingId === cue.id ? "■" : "▶"}
                </button>
                <span className="reference-time">{formatShort(cue.start)}</span>
                <span className="reference-length">{(cue.end - cue.start).toFixed(1)} s</span>
                <span className="reference-text">
                  {cue.mode === "thought" && <span className="reference-thought">thought </span>}
                  {speechText(cue) || <em>(no text)</em>}
                </span>
              </label>
            ))}
          </div>

          <ReferenceAmount count={picked.length} noun="cue" total={total} />
          <TemplateOption choice={template} disabled={busy} onChange={setTemplate} />
          {error && <p className="error">{error}</p>}
        </div>

        <footer className="modal-footer">
          <button type="button" onClick={() => setChosen(new Set())} disabled={busy || chosen.size === 0}>
            Clear
          </button>
          <span className="modal-footer-spacer" />
          <button type="button" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || picked.length === 0 || used <= 0}
            onClick={() => void build()}
          >
            {busy ? "Isolating the voice…" : "Build voice"}
          </button>
        </footer>
      </div>
    </div>
  );
}
