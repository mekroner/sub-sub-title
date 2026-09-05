import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { EngineProgress, EngineStatus, TranscribeProgress } from "../types";
import {
  cancelTranscribe,
  errorMessage,
  installEngine,
  transcribeStatus,
  transcribeVideo,
} from "../lib/api";
import {
  AUTO_DETECT,
  WHISPER_LANGUAGES,
  WHISPER_MODELS,
  formatBytes,
  formatEta,
  modelSize,
} from "../lib/whisper";

interface Props {
  videoPath: string;
  /** How many cues the transcription would replace. */
  cueCount: number;
  model: string;
  language: string;
  /** Persisted to settings, so the next run remembers the choice. */
  onChoiceChange: (choice: { model: string; language: string }) => void;
  onDone: (srtText: string) => void;
  onClose: () => void;
}

type Busy = "installing" | "transcribing" | null;

/** What the progress bar is showing, in words the user can act on. */
const PHASE_LABELS: Record<string, string> = {
  downloading: "Downloading the transcription engine",
  verifying: "Checking the download",
  extracting: "Unpacking the engine",
  locating: "Finishing the install",
  done: "Engine installed",
  starting: "Starting the engine",
  modelDownload: "Downloading the speech model (first run only)",
  vad: "Finding speech in the audio",
  transcribing: "Transcribing",
};

export function TranscribeDialog({
  videoPath,
  cueCount,
  model,
  language,
  onChoiceChange,
  onDone,
  onClose,
}: Props) {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [phase, setPhase] = useState("starting");
  const [fraction, setFraction] = useState(-1);
  const [detail, setDetail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(
    (forModel: string) => {
      transcribeStatus(forModel)
        .then(setStatus)
        .catch((e) => setError(errorMessage(e)));
    },
    [],
  );

  useEffect(() => {
    refreshStatus(model);
  }, [refreshStatus, model]);

  useEffect(() => {
    const engine = listen<EngineProgress>("engine-progress", (event) => {
      const p = event.payload;
      setPhase(p.phase);
      setFraction(p.fraction);
      setDetail(
        p.phase === "downloading"
          ? [
              `${formatBytes(p.bytesDone)} of ${formatBytes(p.bytesTotal)}`,
              p.speedBps > 0 ? `${formatBytes(p.speedBps)}/s` : null,
              formatEta(p.etaSeconds),
            ]
              .filter(Boolean)
              .join(" · ")
          : p.detail,
      );
    });
    const run = listen<TranscribeProgress>("transcribe-progress", (event) => {
      setPhase(event.payload.phase);
      setFraction(event.payload.fraction);
      setDetail(event.payload.message);
    });
    return () => {
      engine.then((fn) => fn());
      run.then((fn) => fn());
    };
  }, []);

  const beginPhase = (kind: Busy) => {
    setBusy(kind);
    setError(null);
    setFraction(-1);
    setDetail("");
    setPhase(kind === "installing" ? "downloading" : "starting");
  };

  const install = async () => {
    beginPhase("installing");
    try {
      setStatus(await installEngine(model));
    } catch (e) {
      setError(errorMessage(e));
      refreshStatus(model);
    } finally {
      setBusy(null);
    }
  };

  const start = async () => {
    beginPhase("transcribing");
    try {
      const srt = await transcribeVideo({
        videoPath,
        language: language === AUTO_DETECT ? null : language,
        model,
      });
      onDone(srt);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
      refreshStatus(model);
    }
  };

  const installed = status?.installed ?? false;
  const partial = status?.partialBytes ?? 0;
  const percent = fraction >= 0 ? Math.round(fraction * 100) : null;
  const primaryLabel = installed
    ? "Transcribe"
    : partial > 0 && status
      ? `Resume download (${Math.round((partial / status.downloadBytes) * 100)}%)`
      : `Download engine (${formatBytes(status?.downloadBytes ?? 0)})`;

  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : onClose}>
      <div
        className="modal narrow"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          // A run in flight owns the dialog until it finishes or fails.
          if (e.key === "Escape" && !busy) onClose();
        }}
      >
        <header className="modal-header">
          <h2>Transcribe audio to subtitles</h2>
          {!busy && (
            <button type="button" className="icon-button" onClick={onClose}>
              ✕
            </button>
          )}
        </header>

        <div className="modal-body">
          <label className="field">
            <span>Language</span>
            <select
              value={language}
              disabled={Boolean(busy)}
              onChange={(e) => onChoiceChange({ model, language: e.target.value })}
            >
              {WHISPER_LANGUAGES.map((entry) => (
                <option key={entry.code || "auto"} value={entry.code}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Model</span>
            <select
              value={model}
              disabled={Boolean(busy)}
              onChange={(e) => onChoiceChange({ model: e.target.value, language })}
            >
              {WHISPER_MODELS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label} ({entry.sizeLabel})
                </option>
              ))}
            </select>
          </label>

          {/* Say what the first run costs before it starts, not halfway through
              a multi-gigabyte download. */}
          {!busy && status && !installed && (
            <p className="hint">
              First use downloads the transcription engine (
              {formatBytes(status.downloadBytes)}) and the model ({modelSize(model)})
              — around 5.5 GB on disk once unpacked.
            </p>
          )}
          {!busy && status && installed && !status.modelPresent && (
            <p className="hint">
              The {modelSize(model)} model has not been downloaded yet; the first
              transcription with it will fetch it.
            </p>
          )}
          {!busy && installed && cueCount > 0 && (
            <p className="hint">
              This replaces all {cueCount} cues currently in the project.
            </p>
          )}

          {busy && (
            <div className="progress">
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${Math.max(fraction, 0) * 100}%` }}
                />
              </div>
              <span className="hint">
                {PHASE_LABELS[phase] ?? phase}
                {percent !== null ? ` · ${percent}%` : "…"}
                {detail ? ` · ${detail}` : ""}
              </span>
            </div>
          )}

          {error && <p className="error">{error}</p>}
        </div>

        <footer className="modal-footer">
          {busy ? (
            <button
              type="button"
              className="danger"
              onClick={() => cancelTranscribe().catch(() => undefined)}
            >
              {busy === "installing" ? "Cancel download" : "Cancel transcription"}
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose}>
                Close
              </button>
              <button
                type="button"
                className="primary"
                disabled={!status}
                onClick={installed ? start : install}
              >
                {primaryLabel}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
