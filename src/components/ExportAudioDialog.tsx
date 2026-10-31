import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import type { MixdownProgress, MixdownRequest, MixdownResult } from "../types";
import { cancelMixdown, errorMessage, mixdownVoiceover } from "../lib/api";
import { formatDuration } from "../lib/time";

interface Props {
  defaultOutput: string;
  /** The mix as it stands, minus where it goes. */
  request: Omit<MixdownRequest, "outputPath">;
  onClose: () => void;
}

const FORMATS = [
  { name: "WAV (24-bit)", extensions: ["wav"] },
  { name: "FLAC", extensions: ["flac"] },
  { name: "MP3 (320 kbps)", extensions: ["mp3"] },
  { name: "M4A / AAC (256 kbps)", extensions: ["m4a"] },
];

/** Renders the Voiceover tab's mix to an audio file: what the preview plays. */
export function ExportAudioDialog({ defaultOutput, request, onClose }: Props) {
  const [output, setOutput] = useState(defaultOutput);
  const [fraction, setFraction] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MixdownResult | null>(null);

  useEffect(() => {
    const unlisten = listen<MixdownProgress>("mixdown-progress", (event) =>
      setFraction(event.payload.fraction),
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const start = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setFraction(0);
    try {
      setResult(await mixdownVoiceover({ ...request, outputPath: output.trim() }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const clipCount = request.clips.length;

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
          <h2>Export voiceover audio</h2>
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
                  const picked = await save({ defaultPath: output, filters: FORMATS });
                  if (picked) setOutput(picked);
                }}
              >
                Browse…
              </button>
            </div>
          </label>

          <p className="hint">
            Mixes the original audio with {clipCount} clip{clipCount === 1 ? "" : "s"} exactly as
            the Voiceover tab plays them — faders, mute and solo, curves and the duck under the
            cues — at 48 kHz stereo. The format follows the extension: .wav, .flac, .mp3 or .m4a.
            {!request.includeOriginal && " This video has no audio, so only the clips are mixed."}
          </p>

          {busy && (
            <div className="progress">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${fraction * 100}%` }} />
              </div>
              <span className="hint">
                {Math.round(fraction * 100)}% of {formatDuration(request.duration)}
              </span>
            </div>
          )}

          {result && (
            <>
              <p className="status">
                Saved {formatDuration(result.seconds)} to {output}. Peak{" "}
                {Number.isFinite(result.peakDb) ? `${result.peakDb.toFixed(1)} dBFS` : "silent"}.
              </p>
              {result.clipped > 0 && (
                <p className="error">
                  {result.clipped.toLocaleString()} samples went past full scale and were clipped.
                  Lower a track's gain and export again.
                </p>
              )}
            </>
          )}
          {error && <p className="error">{error}</p>}
        </div>

        <footer className="modal-footer">
          {busy ? (
            <button type="button" className="danger" onClick={() => cancelMixdown().catch(() => undefined)}>
              Cancel export
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose}>
                Close
              </button>
              <button type="button" className="primary" disabled={!output.trim()} onClick={start}>
                {result ? "Export again" : "Export"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
