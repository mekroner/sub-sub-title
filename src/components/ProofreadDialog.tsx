import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Cue, ProofreadCorrection, ProofreadProgress } from "../types";
import { aiProofread, cancelProofread, errorMessage } from "../lib/api";

interface Props {
  cues: Cue[];
  /** The current multi-selection, offered as a narrower scope. */
  selectedIds: Set<string>;
  model: string;
  onApply: (corrections: ProofreadCorrection[], cues: Cue[]) => void;
  onClose: () => void;
}

/**
 * Runs the AI proofread over the project and hands the findings back to the cue
 * list, where they show up as issues on the cues they belong to. Nothing is
 * changed automatically — every correction is applied by hand from the badge or
 * the right-click menu.
 */
export function ProofreadDialog({ cues, selectedIds, model, onApply, onClose }: Props) {
  const [wholeProject, setWholeProject] = useState(selectedIds.size < 2);
  const [progress, setProgress] = useState<ProofreadProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<number | null>(null);

  useEffect(() => {
    const unlisten = listen<ProofreadProgress>("proofread-progress", (event) =>
      setProgress(event.payload),
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const scope = wholeProject ? cues : cues.filter((cue) => selectedIds.has(cue.id));
  const checkable = scope.filter((cue) => cue.text.trim() !== "");

  const start = async () => {
    setBusy(true);
    setError(null);
    setFound(null);
    setProgress(null);
    try {
      const corrections = await aiProofread({
        model,
        cues: checkable.map((cue) => ({ id: cue.id, text: cue.text })),
      });
      onApply(corrections, checkable);
      setFound(corrections.length);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const pct = progress ? progress.fraction : 0;

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
          <h2>Proofread with AI</h2>
          {!busy && (
            <button type="button" className="icon-button" onClick={onClose}>
              ✕
            </button>
          )}
        </header>

        <div className="modal-body">
          <p className="hint">
            Sends the cue text to OpenRouter for a second opinion on spelling, grammar
            and punctuation. Findings appear on the cues themselves — nothing is
            changed until you apply it.
          </p>

          <fieldset>
            <legend>Scope</legend>
            <label className="field checkbox">
              <input
                type="radio"
                name="proofread-scope"
                checked={wholeProject}
                disabled={busy}
                onChange={() => setWholeProject(true)}
              />
              <span>Whole project ({cues.length} cues)</span>
            </label>
            <label className="field checkbox">
              <input
                type="radio"
                name="proofread-scope"
                checked={!wholeProject}
                disabled={busy || selectedIds.size === 0}
                onChange={() => setWholeProject(false)}
              />
              <span>
                Selected cues ({selectedIds.size}
                {selectedIds.size === 0 ? " — nothing selected" : ""})
              </span>
            </label>
          </fieldset>

          <p className="hint">
            Model: <code>{model || "none selected"}</code>
          </p>

          {busy && (
            <div className="progress">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${pct * 100}%` }} />
              </div>
              <span className="hint">
                {progress
                  ? `${progress.done} of ${progress.total} cues · ${Math.round(pct * 100)}%`
                  : "Starting…"}
              </span>
            </div>
          )}

          {found !== null && (
            <p className="status">
              {found === 0
                ? "No corrections suggested."
                : `${found} suggestion${found === 1 ? "" : "s"} — review them in the cue list.`}
            </p>
          )}
          {error && <p className="error">{error}</p>}
        </div>

        <footer className="modal-footer">
          {busy ? (
            <button
              type="button"
              onClick={() => void cancelProofread().catch(() => undefined)}
            >
              Cancel proofread
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose}>
                Close
              </button>
              <button
                type="button"
                className="primary"
                disabled={checkable.length === 0 || !model}
                onClick={() => void start()}
              >
                {found === null ? "Start" : "Run again"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
