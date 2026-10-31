import type { VoiceClip, VoiceTrack } from "../types";
import { formatShort } from "../lib/time";
import { MAX_DB, MIN_DB, clipEnd, type ClipPatch } from "../lib/voiceover";
import { formatDb } from "./VoiceoverTimeline";

interface Props {
  clip: VoiceClip | null;
  track: VoiceTrack | null;
  onPatch: (patch: ClipPatch) => void;
  onMoveToPlayhead: () => void;
  onRemove: () => void;
}

/** The selected clip's details, in the side column of the Voiceover tab. */
export function ClipInspector({ clip, track, onPatch, onMoveToPlayhead, onRemove }: Props) {
  return (
    <section className="panel clip-inspector">
      <header className="panel-header">
        <h2>Clip</h2>
      </header>
      {!clip ? (
        <p className="hint clip-inspector-empty">
          Select a clip on a voice track. Add audio with a track's <strong>+ Audio</strong>{" "}
          button; it lands at the playhead.
        </p>
      ) : (
        <div className="clip-inspector-body">
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
          <div className="clip-actions">
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
