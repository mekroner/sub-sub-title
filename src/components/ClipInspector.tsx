import type { VoiceClip, VoiceTrack } from "../types";
import { formatShort } from "../lib/time";
import { MAX_DB, MIN_DB, clipEnd, type ClipPatch } from "../lib/voiceover";
import { isSuspect } from "../lib/tts";
import { formatDb } from "./VoiceoverTimeline";

interface Props {
  clip: VoiceClip | null;
  track: VoiceTrack | null;
  /** The cue a generated clip was spoken from, as it reads now; null if deleted. */
  cueText: string | null;
  stale: boolean;
  /** Seconds the clip runs past its cue; 0 when it fits. */
  overrun: number;
  /** Whether a new take can be spoken now. */
  canSpeak: boolean;
  onPatch: (patch: ClipPatch) => void;
  onMoveToPlayhead: () => void;
  onMoveToCue: () => void;
  onSelectTake: (index: number) => void;
  onRemoveTake: (index: number) => void;
  onNewTake: () => void;
  onRemove: () => void;
}

/** The selected clip's details, in the side column of the Voiceover tab. */
export function ClipInspector({
  clip,
  track,
  cueText,
  stale,
  overrun,
  canSpeak,
  onPatch,
  onMoveToPlayhead,
  onMoveToCue,
  onSelectTake,
  onRemoveTake,
  onNewTake,
  onRemove,
}: Props) {
  const source = clip?.source;
  return (
    <section className="panel clip-inspector">
      <header className="panel-header">
        <h2>Clip</h2>
      </header>
      {!clip ? (
        <p className="hint clip-inspector-empty">
          Select a clip on a voice track. Generate lines from the Cast panel, or add audio with a
          track's <strong>+ Audio</strong> button; it lands at the playhead.
        </p>
      ) : (
        <div className="clip-inspector-body">
          {source && (
            <div className="clip-line">
              <span className="clip-line-text">“{source.text}”</span>
              {stale && (
                <p className="clip-warning">
                  {cueText === null
                    ? "Its cue has been deleted."
                    : "The cue or its voice has changed since this was spoken."}
                </p>
              )}
              {overrun > 0 && (
                <p className="clip-warning">
                  Runs {overrun.toFixed(2)} s past the end of its cue.
                </p>
              )}
            </div>
          )}
          <label className="clip-field">
            <span>Name</span>
            <input value={clip.name} onChange={(e) => onPatch({ name: e.target.value })} />
          </label>
          <div className="clip-facts">
            <span>Track</span>
            <span>{track?.name ?? "—"}</span>
            <span>Time</span>
            <span>
              {formatShort(clip.start)} – {formatShort(clipEnd(clip))}
            </span>
            <span>Length</span>
            <span>
              {clip.duration.toFixed(2)} s
              {clip.duration < clip.sourceDuration - 0.005 &&
                ` of ${clip.sourceDuration.toFixed(2)} s`}
            </span>
            <span>File</span>
            <span className="clip-path" title={clip.file}>
              {clip.file}
            </span>
          </div>
          <label className="clip-field">
            <span>Gain</span>
            <input
              type="range"
              min={MIN_DB}
              max={MAX_DB}
              step={0.5}
              value={clip.gainDb}
              onChange={(e) => onPatch({ gainDb: Number(e.target.value) })}
              onDoubleClick={() => onPatch({ gainDb: 0 })}
              title="Double-click for 0 dB"
            />
            <span className="vo-gain-value">{formatDb(clip.gainDb)}</span>
          </label>

          {source && (
            <div className="clip-takes">
              <div className="clip-takes-head">
                <span>Takes</span>
                <button
                  type="button"
                  className="small"
                  disabled={!canSpeak || cueText === null}
                  onClick={onNewTake}
                  title="Speak the cue again, as it reads now, with a new seed"
                >
                  New take
                </button>
              </div>
              {(clip.takes ?? []).map((take, i) => (
                <label key={take.file} className="clip-take">
                  <input
                    type="radio"
                    name={`take-${clip.id}`}
                    checked={take.file === clip.file}
                    onChange={() => onSelectTake(i)}
                  />
                  <span>Take {i + 1}</span>
                  <span className="clip-take-meta">
                    {(take.speech ? take.speech[1] - take.speech[0] : take.duration).toFixed(2)} s · seed{" "}
                    {take.seed}
                  </span>
                  {isSuspect(take) && (
                    <span
                      className="clip-take-suspect"
                      title={`The words were hard to find in this take (score ${take.check!.score.toFixed(2)}, ${take.check!.rate.toFixed(1)} letters/s): it may have dropped or garbled some.`}
                    >
                      ⚠
                    </span>
                  )}
                  <button
                    type="button"
                    className="icon-button clip-take-delete"
                    onClick={(e) => {
                      // Inside the label: without this the click would also
                      // select the take being deleted.
                      e.preventDefault();
                      onRemoveTake(i);
                    }}
                    title={
                      (clip.takes?.length ?? 0) === 1
                        ? "Delete this take — the only one, so the clip goes too"
                        : "Delete this take"
                    }
                    aria-label={`Delete take ${i + 1}`}
                  >
                    ×
                  </button>
                </label>
              ))}
            </div>
          )}

          <div className="clip-actions">
            {source && cueText !== null && (
              <button type="button" className="small" onClick={onMoveToCue} title="Line the clip up with its cue's start">
                Snap to cue
              </button>
            )}
            <button type="button" className="small" onClick={onMoveToPlayhead}>
              Move to playhead
            </button>
            <button type="button" className="small danger" onClick={onRemove}>
              Remove
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
