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

/** Installs the local voice engine: Python, PyTorch with CUDA, Chatterbox. */
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
          <h2>Install the voice engine</h2>
          {!busy && (
            <button type="button" className="icon-button" onClick={onClose}>
              ✕
            </button>
          )}
        </header>

        <div className="modal-body">
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
              Cancel install
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose}>
                Close
              </button>
              <button type="button" className="primary" disabled={lowOnSpace} onClick={start}>
                {error ? "Try again" : "Install"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
