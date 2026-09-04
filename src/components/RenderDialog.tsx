import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import type { RenderProgress } from "../types";
import { cancelRender, errorMessage, renderBurnIn, writeTextFile } from "../lib/api";
import { formatDuration } from "../lib/time";

interface Props {
  videoPath: string;
  defaultOutput: string;
  assPath: string;
  assText: string;
  duration: number;
  onClose: () => void;
}

export function RenderDialog({
  videoPath,
  defaultOutput,
  assPath,
  assText,
  duration,
  onClose,
}: Props) {
  const [output, setOutput] = useState(defaultOutput);
  const [crf, setCrf] = useState(18);
  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const unlisten = listen<RenderProgress>("render-progress", (event) =>
      setProgress(event.payload),
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const start = async () => {
    setBusy(true);
    setError(null);
    setDone(false);
    setProgress(null);
    try {
      // Write the .ass fresh so the render always matches what is on screen.
      await writeTextFile(assPath, assText);
      await renderBurnIn({
        videoPath,
        assPath,
        outputPath: output,
        duration,
        crf,
      });
      setDone(true);
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
        onKeyDown={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>Burn subtitles into video</h2>
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
              <input
                value={output}
                onChange={(e) => setOutput(e.target.value)}
                disabled={busy}
              />
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
            Re-encodes the video with libx264 and copies the audio untouched. Expect
            this to take a while for a {formatDuration(duration)} file.
          </p>

          {busy && (
            <div className="progress">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${pct * 100}%` }} />
              </div>
              <span className="hint">
                {progress
                  ? `${formatDuration(progress.timeSeconds)} of ${formatDuration(
                      duration,
                    )} · ${Math.round(pct * 100)}% · ${progress.speed}`
                  : "Starting ffmpeg…"}
              </span>
            </div>
          )}

          {done && <p className="status">Finished. Saved to {output}</p>}
          {error && <p className="error">{error}</p>}
        </div>

        <footer className="modal-footer">
          {busy ? (
            <button
              type="button"
              className="danger"
              onClick={() => cancelRender().catch(() => undefined)}
            >
              Cancel render
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose}>
                Close
              </button>
              <button
                type="button"
                className="primary"
                disabled={!output.trim()}
                onClick={start}
              >
                {done ? "Render again" : "Start render"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
