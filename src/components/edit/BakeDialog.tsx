import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import type { BakeProgress, RenderPlan } from "../../types";
import { bakeEdit, cancelBake, errorMessage } from "../../lib/api";
import { samePath } from "../../lib/editPlan";
import { formatDuration } from "../../lib/time";

interface Props {
  plan: RenderPlan;
  planHash: string;
  defaultOutput: string;
  /** Files the bake must never overwrite: its sources. */
  sources: string[];
  /** Cues or voice clips exist, timed against the current video. */
  rebakeWarning: boolean;
  /**
   * What the bake will do to cues, clips, sections and beats, when it can
   * trace them through the cut; null when it cannot, and the warning stands.
   */
  recutPreview?: string | null;
  /** Run before the encode: writes the drawn text where the bake reads it. */
  prepare?: () => Promise<void>;
  /** Called once the file is written; the dialog closes after. */
  onBaked: (path: string, planHash: string) => Promise<void>;
  onClose: () => void;
}

/** Bakes the edit to an MP4, which then becomes the project's video. */
export function BakeDialog({
  plan,
  planHash,
  defaultOutput,
  sources,
  rebakeWarning,
  recutPreview,
  prepare,
  onBaked,
  onClose,
}: Props) {
  const [output, setOutput] = useState(defaultOutput);
  const [crf, setCrf] = useState(18);
  const [progress, setProgress] = useState<BakeProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setOutput(defaultOutput), [defaultOutput]);

  useEffect(() => {
    const unlisten = listen<BakeProgress>("bake-progress", (event) => setProgress(event.payload));
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const overwritesSource = sources.some((s) => samePath(s, output));

  const start = async () => {
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      await prepare?.();
      await bakeEdit({ plan, outputPath: output, crf });
      await onBaked(output, planHash);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const pct = progress && progress.fraction >= 0 ? progress.fraction : 0;

  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : onClose}>
      <div
        className="modal narrow"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" && !busy) onClose();
        }}
      >
        <header className="modal-header">
          <h2>Bake the edit</h2>
          {!busy && (
            <button type="button" className="icon-button" onClick={onClose}>
              ✕
            </button>
          )}
        </header>

        <div className="modal-body">
          <label className="field">
            <span>Output file</span>
            <div className="field-row">
              <input value={output} onChange={(e) => setOutput(e.target.value)} disabled={busy} />
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  const picked = await save({
                    defaultPath: output,
                    filters: [{ name: "MP4 video", extensions: ["mp4"] }],
                  });
                  if (picked) setOutput(picked);
                }}
              >
                Browse…
              </button>
            </div>
          </label>

          <label className="field">
            <span>Quality (CRF — lower is better and larger; 18 is near-lossless)</span>
            <input
              type="number"
              min={0}
              max={51}
              value={crf}
              disabled={busy}
              onChange={(e) => setCrf(Number(e.target.value))}
            />
          </label>

          <p className="hint">
            Renders {formatDuration(plan.total)} at {plan.width}×{plan.height}, {plan.fps} fps, with
            libx264 and AAC. The baked file becomes the project's video: Subtitles and Voiceover
            work on it from then on.
          </p>
          {recutPreview ? (
            <p className="hint">Timing follows the cut: {recutPreview}.</p>
          ) : rebakeWarning && (
            <p className="error">
              Cues or voice clips are timed against the current video. If this cut moves things,
              their timing will no longer line up.
            </p>
          )}
          {overwritesSource && <p className="error">That file is one of the edit's sources. Choose another name.</p>}

          {busy && (
            <div className="progress">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${pct * 100}%` }} />
              </div>
              <span className="hint">
                {!progress
                  ? "Starting ffmpeg…"
                  : `${formatDuration(progress.timeSeconds)} of ${formatDuration(plan.total)} · ${Math.round(
                      pct * 100,
                    )}% · ${progress.speed}`}
              </span>
            </div>
          )}

          {error && <p className="error">{error}</p>}
        </div>

        <footer className="modal-footer">
          {busy ? (
            <button type="button" className="danger" onClick={() => cancelBake().catch(() => undefined)}>
              Cancel bake
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose}>
                Close
              </button>
              <button
                type="button"
                className="primary"
                disabled={!output.trim() || overwritesSource || plan.total <= 0}
                onClick={start}
              >
                Bake
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
