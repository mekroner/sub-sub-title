import { useEffect, useState } from "react";
import type { ModelInfo, Settings } from "../types";
import {
  clearApiKey,
  errorMessage,
  listModels,
  setApiKey as storeApiKey,
} from "../lib/api";

interface Props {
  settings: Settings;
  apiKeySet: boolean;
  onSave: (settings: Settings) => void;
  onApiKeyChange: (present: boolean) => void;
  onClose: () => void;
}

export function SettingsDialog({
  settings,
  apiKeySet,
  onSave,
  onApiKeyChange,
  onClose,
}: Props) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [keyInput, setKeyInput] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelFilter, setModelFilter] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  useEffect(() => {
    // The model catalogue changes often enough that hardcoding ids goes stale.
    listModels()
      .then(setModels)
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const visibleModels = models
    .filter((m) => m.id.toLowerCase().includes(modelFilter.toLowerCase()))
    .slice(0, 60);

  const saveKey = async () => {
    setError(null);
    try {
      await storeApiKey(keyInput);
      setKeyInput("");
      setStatus("API key saved to Windows Credential Manager.");
      onApiKeyChange(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const removeKey = async () => {
    setError(null);
    try {
      await clearApiKey();
      setStatus("API key removed.");
      onApiKeyChange(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          // Escape abandons the draft, the same as Cancel.
          if (e.key === "Escape") onClose();
        }}
      >
        <header className="modal-header">
          <h2>Settings</h2>
          <button type="button" className="icon-button" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          <fieldset>
            <legend>OpenRouter</legend>

            <p className="hint">
              The key is stored in Windows Credential Manager and is only ever read
              by the Rust backend — it never reaches this window.
            </p>

            <div className="field-row">
              <input
                type="password"
                placeholder={apiKeySet ? "A key is saved — paste to replace" : "sk-or-..."}
                value={keyInput}
                autoComplete="off"
                onChange={(e) => setKeyInput(e.target.value)}
              />
              <button type="button" disabled={!keyInput.trim()} onClick={saveKey}>
                Save key
              </button>
              {apiKeySet && (
                <button type="button" className="danger" onClick={removeKey}>
                  Remove
                </button>
              )}
            </div>

            <label className="field">
              <span>Model</span>
              <input
                value={draft.model}
                onChange={(e) => set("model", e.target.value)}
                placeholder="anthropic/claude-sonnet-4.5"
              />
            </label>

            <label className="field">
              <span>Filter the model list</span>
              <input
                value={modelFilter}
                placeholder={
                  models.length ? `${models.length} models available` : "loading…"
                }
                onChange={(e) => setModelFilter(e.target.value)}
              />
            </label>

            {modelFilter && (
              <div className="model-list">
                {visibleModels.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={m.id === draft.model ? "model selected" : "model"}
                    onClick={() => set("model", m.id)}
                  >
                    <strong>{m.id}</strong>
                    <span>{m.name}</span>
                  </button>
                ))}
                {visibleModels.length === 0 && (
                  <p className="hint">No model ids match that filter.</p>
                )}
              </div>
            )}

            <div className="field-grid">
              <label className="field">
                <span>Temperature</span>
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={draft.temperature}
                  onChange={(e) => set("temperature", Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>Context lines</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={draft.contextLines}
                  onChange={(e) => set("contextLines", Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>Candidates</span>
                <input
                  type="number"
                  min={1}
                  max={6}
                  value={draft.candidateCount}
                  onChange={(e) => set("candidateCount", Number(e.target.value))}
                />
              </label>
            </div>

            <label className="field">
              <span>Style notes (sent with every request)</span>
              <textarea
                rows={2}
                value={draft.styleNotes}
                placeholder="e.g. Norwegian dialogue, dry humour, 1970s setting"
                onChange={(e) => set("styleNotes", e.target.value)}
              />
            </label>
          </fieldset>

          <fieldset>
            <legend>Caption style (.ass export and preview)</legend>
            <div className="field-grid">
              <label className="field">
                <span>Font</span>
                <input
                  value={draft.fontName}
                  onChange={(e) => set("fontName", e.target.value)}
                />
              </label>
              <label className="field">
                <span>Size (px at video height)</span>
                <input
                  type="number"
                  min={8}
                  max={200}
                  value={draft.fontSize}
                  onChange={(e) => set("fontSize", Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>Outline (0 draws none)</span>
                <input
                  type="number"
                  min={0}
                  max={10}
                  step={0.5}
                  value={draft.outline}
                  onChange={(e) => set("outline", Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>Outline colour</span>
                <input
                  type="color"
                  value={draft.outlineColor}
                  onChange={(e) => set("outlineColor", e.target.value)}
                />
              </label>
              <label className="field">
                <span>Shadow</span>
                <input
                  type="number"
                  min={0}
                  max={10}
                  step={0.5}
                  value={draft.shadow}
                  onChange={(e) => set("shadow", Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>Shadow colour</span>
                <input
                  type="color"
                  value={draft.shadowColor}
                  onChange={(e) => set("shadowColor", e.target.value)}
                />
              </label>
              <label className="field checkbox">
                <input
                  type="checkbox"
                  checked={draft.bold}
                  onChange={(e) => set("bold", e.target.checked)}
                />
                <span>Bold</span>
              </label>
            </div>
            <p className="hint">
              Text colour comes from each speaker; captions with no speaker are white.
            </p>
          </fieldset>

          <fieldset>
            <legend>Timing and readability</legend>
            <div className="field-grid">
              <label className="field">
                <span>Minimum gap between cues (seconds)</span>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={draft.minGap}
                  onChange={(e) => set("minGap", Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>Characters per line</span>
                <input
                  type="number"
                  min={10}
                  max={120}
                  value={draft.maxCharsPerLine}
                  onChange={(e) => set("maxCharsPerLine", Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>Lines per cue</span>
                <input
                  type="number"
                  min={1}
                  max={6}
                  value={draft.maxLines}
                  onChange={(e) => set("maxLines", Number(e.target.value))}
                />
              </label>
            </div>
            <p className="hint">
              Cues may not overlap: edits are clamped to leave the gap above. The two
              limits only flag a cue in the list; nothing is rewritten for you.
            </p>
          </fieldset>

          <fieldset>
            <legend>Spelling</legend>
            <label className="field checkbox">
              <input
                type="checkbox"
                checked={draft.spellcheck}
                onChange={(e) => set("spellcheck", e.target.checked)}
              />
              <span>Check spelling and grammar as I type</span>
            </label>
            <label className="field">
              <span>Dialect</span>
              <select
                value={draft.dialect}
                disabled={!draft.spellcheck}
                onChange={(e) => set("dialect", e.target.value as Settings["dialect"])}
              >
                <option value="american">American English</option>
                <option value="british">British English</option>
              </select>
            </label>
            <p className="hint">
              Runs offline on this machine; the checker is English-only. Right-click a
              flagged cue to fix it, or to add the word to a dictionary. “Proofread with
              AI” in the Edit menu is a separate, optional pass that does send cue text
              to OpenRouter.
            </p>
          </fieldset>

          <fieldset>
            <legend>Waveform</legend>
            <label className="field">
              <span>
                Resolution (points per second) — higher is more precise but slower to
                extract
              </span>
              <input
                type="number"
                min={10}
                max={400}
                step={10}
                value={draft.peaksResolution}
                onChange={(e) => set("peaksResolution", Number(e.target.value))}
              />
            </label>
            <p className="hint">
              Changing this re-extracts the waveform the next time a video is opened.
            </p>
          </fieldset>

          {status && <p className="status">{status}</p>}
          {error && <p className="error">{error}</p>}
        </div>

        <footer className="modal-footer">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              onSave(draft);
              onClose();
            }}
          >
            Save settings
          </button>
        </footer>
      </div>
    </div>
  );
}
