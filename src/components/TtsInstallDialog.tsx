import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { TtsInstallProgress, TtsStatus } from "../types";
import { cancelTtsInstall, errorMessage, installTts } from "../lib/api";

interface Props {
  status: TtsStatus | null;
  onInstalled: () => void;
  onClose: () => void;
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1e6)} MB`;
}

/**
 * Installs the local voice engine: Python, PyTorch with CUDA, Chatterbox. An
 * engine installed before something was added to it is updated instead,
 * keeping everything it already has.
 */
export function TtsInstallDialog({ status, onInstalled, onClose }: Props) {
  const [progress, setProgress] = useState<TtsInstallProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = listen<TtsInstallProgress>("tts-install-progress", (event) =>
      setProgress(event.payload),
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const start = async () => {
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      await installTts();
      onInstalled();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const lowOnSpace =
    status !== null &&
    status.diskFreeBytes > 0 &&
    status.diskFreeBytes < status.requiredFreeBytes;
  const fraction = progress ? (progress.step - 1) / progress.steps : 0;
  const updating = status?.installed === true && status.needsUpdate;

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
          <h2>{updating ? "Update the voice engine" : "Install the voice engine"}</h2>
          {!busy && (
            <button type="button" className="icon-button" onClick={onClose}>
              ✕
            </button>
          )}
        </header>

        <div className="modal-body">
          {updating ? (
            <p>
              The update adds <strong>Demucs</strong> (Meta, MIT licence), which takes the music
              and effects out of the lines a voice is cloned from, so only the voice is cloned. It
              downloads about {megabytes(status.updateBytes)} and keeps everything already
              installed.
            </p>
          ) : (
            <>
              <p>
                Voices are generated on this computer by <strong>Chatterbox</strong> (Resemble AI, MIT
                licence), on your NVIDIA GPU. Nothing is sent anywhere, and nothing is filtered.
              </p>
              <p className="hint">
                The install downloads about {gigabytes(status?.downloadBytes ?? 7e9)}: a private
                Python, PyTorch with CUDA and the model. It needs about{" "}
                {gigabytes(status?.requiredFreeBytes ?? 16 * 1024 ** 3)} free while installing
                {status && status.diskFreeBytes > 0 ? ` (${gigabytes(status.diskFreeBytes)} free now)` : ""}
                . It does not touch any Python you already have. Chatterbox marks what it generates
                with an inaudible watermark.
              </p>
            </>
          )}

          {busy && (
            <div className="progress">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${fraction * 100}%` }} />
              </div>
              <span className="hint">
                {progress ? `Step ${progress.step} of ${progress.steps}: ${progress.label}` : "Starting…"}
              </span>
              {progress?.detail && <span className="hint install-detail">{progress.detail}</span>}
            </div>
          )}

          {lowOnSpace && !busy && (
            <p className="error">There is not enough free disk space for the install.</p>
          )}
          {error && <p className="error install-error">{error}</p>}
        </div>

        <footer className="modal-footer">
          {busy ? (
            <button
              type="button"
              className="danger"
              onClick={() => cancelTtsInstall().catch(() => undefined)}
            >
              {updating ? "Cancel update" : "Cancel install"}
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose}>
                Close
              </button>
              <button type="button" className="primary" disabled={lowOnSpace} onClick={start}>
                {error ? "Try again" : updating ? "Update" : "Install"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
