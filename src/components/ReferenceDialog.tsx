import { useMemo, useState } from "react";
import type { Cue } from "../types";
import { errorMessage } from "../lib/api";
import { formatShort } from "../lib/time";
import { REFERENCE_MAX_SECONDS, speechText } from "../lib/tts";

interface Props {
  speakerName: string;
  /** Every cue of the speaker, in time order. */
  cues: Cue[];
  /** Ticked when the dialog opens: the last choice, or a suggestion. */
  initial: Set<string>;
  /** The cue whose stretch of video is playing, if any. */
  playingId: string | null;
  onPlay: (cue: Cue) => void;
  onStop: () => void;
  onBuild: (chosen: Cue[]) => Promise<void>;
  onClose: () => void;
}

/** Turbo refuses a reference this short; the Expressive model copes, barely. */
const MIN_SECONDS = 5;
const GOOD_SECONDS = 10;

/**
 * Choosing which of a speaker's cues to clone their voice from. A cue is only
 * a guess at where the speaker talks — it may sit over music, another voice,
 * or nobody — so the cues are offered for listening and picking, not taken.
 */
export function ReferenceDialog({
  speakerName,
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
      await onBuild(picked);
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
            Tick the cues where {speakerName} is clearly speaking, alone, without music or other
            voices over them. Listen with ▶. A few clean lines beat many noisy ones.
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

          <p className={total < MIN_SECONDS ? "error" : total < GOOD_SECONDS ? "hint" : "status"}>
            {picked.length} cue{picked.length === 1 ? "" : "s"}, {total.toFixed(1)} s
            {total > REFERENCE_MAX_SECONDS && ` — the first ${REFERENCE_MAX_SECONDS} s are used`}.{" "}
            {total < MIN_SECONDS
              ? `Turbo needs more than ${MIN_SECONDS} s.`
              : total < GOOD_SECONDS
                ? `Enough to work; ${GOOD_SECONDS}–20 s clones better.`
                : "A good amount."}
          </p>
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
            {busy ? "Building…" : "Build voice"}
          </button>
        </footer>
      </div>
    </div>
  );
}
