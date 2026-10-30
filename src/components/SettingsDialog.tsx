import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { ModelInfo, Settings } from "../types";
import {
  clearApiKey,
  errorMessage,
  listModels,
  setApiKey as storeApiKey,
} from "../lib/api";
import { DEFAULT_FILL_GUIDANCE } from "../lib/fill";
import { MAX_CHAT_LINES } from "../lib/chat";

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
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overridingGuidance, setOverridingGuidance] = useState(
    settings.fillGuidanceOverride.trim() !== "",
  );

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  useEffect(() => {
    // The model catalogue changes often enough that hardcoding ids goes stale.
    listModels()
      .then(setModels)
      .catch((e) => setError(errorMessage(e)));
  }, []);

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

            <ModelPicker
              label="Model"
              value={draft.model}
              placeholder="anthropic/claude-sonnet-4.5"
              models={models}
              onChange={(id) => set("model", id)}
            />

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
            </div>
            <p className="hint">
              Used by Fill. Higher is looser; around 0.9 suits dialogue, and the
              latitude chosen in the Fill dialog does more to steer it than this.
            </p>
          </fieldset>

          <fieldset>
            <legend>Fill — writing with AI</legend>

            <label className="field">
              <span>Your instructions (added to every Fill request)</span>
              <textarea
                rows={4}
                value={draft.fillInstructions}
                placeholder={
                  "e.g. Norwegian dialogue, Bergen dialect.\nKeep swearing mild.\nAnna never uses contractions."
                }
                onChange={(e) => set("fillInstructions", e.target.value)}
              />
            </label>
            <p className="hint">
              These sit after the built-in writing guidance and win where the two
              disagree. Anything specific to one project belongs in that project's
              brief, in the Fill dialog.
            </p>

            <label className="field checkbox">
              <input
                type="checkbox"
                checked={overridingGuidance}
                onChange={(e) => {
                  setOverridingGuidance(e.target.checked);
                  if (e.target.checked && !draft.fillGuidanceOverride.trim()) {
                    set("fillGuidanceOverride", DEFAULT_FILL_GUIDANCE);
                  }
                }}
              />
              <span>Replace the built-in writing guidance</span>
            </label>

            {overridingGuidance && (
              <>
                <textarea
                  className="guidance-input"
                  rows={16}
                  value={draft.fillGuidanceOverride}
                  onChange={(e) => set("fillGuidanceOverride", e.target.value)}
                />
                <div className="field-row">
                  <span className="hint">
                    How to read the transcript, the character limits and the reply
                    format are always added after this, so replies can still be read.
                  </span>
                  <button
                    type="button"
                    onClick={() => set("fillGuidanceOverride", DEFAULT_FILL_GUIDANCE)}
                  >
                    Reset to built-in
                  </button>
                </div>
              </>
            )}
          </fieldset>

          <fieldset>
            <legend>Autocomplete — grey text while typing a cue</legend>

            <label className="field checkbox">
              <input
                type="checkbox"
                checked={draft.ghostEnabled}
                onChange={(e) => set("ghostEnabled", e.target.checked)}
              />
              <span>Suggest how a cue continues as I type (Tab accepts)</span>
            </label>

            <ModelPicker
              label="Autocomplete model"
              value={draft.ghostModel}
              placeholder="google/gemini-2.5-flash-lite"
              models={models}
              disabled={!draft.ghostEnabled}
              onChange={(id) => set("ghostModel", id)}
            />

            <div className="field-grid">
              <label className="field">
                <span>Pause before suggesting (ms)</span>
                <input
                  type="number"
                  min={100}
                  max={3000}
                  step={50}
                  disabled={!draft.ghostEnabled}
                  value={draft.ghostDelayMs}
                  onChange={(e) => set("ghostDelayMs", Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>Cues shown before</span>
                <input
                  type="number"
                  min={0}
                  max={40}
                  disabled={!draft.ghostEnabled}
                  value={draft.ghostLinesBefore}
                  onChange={(e) => set("ghostLinesBefore", Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>Cues shown after</span>
                <input
                  type="number"
                  min={0}
                  max={10}
                  disabled={!draft.ghostEnabled}
                  value={draft.ghostLinesAfter}
                  onChange={(e) => set("ghostLinesAfter", Number(e.target.value))}
                />
              </label>
            </div>
            <p className="hint">
              A request goes out on every pause in typing, so pick a small, fast,
              non-reasoning model. At around $0.10 per million input tokens, an hour
              of steady writing costs a few cents. Typing what the suggestion already
              shows costs nothing. Ctrl+→ accepts one word, Esc dismisses, and
              Ctrl+Shift+Space turns it on or off.
            </p>
          </fieldset>

          <fieldset>
            <legend>Chat — the idea panel under Sections</legend>

            <ChatModelList
              value={draft.chatModels}
              models={models}
              onChange={(ids) => set("chatModels", ids)}
            />

            <div className="field-grid">
              <label className="field">
                <span>Lines “Last N” attaches</span>
                <input
                  type="number"
                  min={1}
                  max={MAX_CHAT_LINES}
                  value={draft.chatLinesBefore}
                  onChange={(e) => set("chatLinesBefore", Number(e.target.value))}
                />
              </label>
            </div>
            <p className="hint">
              The chat panel offers these models and a reasoning effort to switch
              between as you talk; the first is used when nothing else is picked.
              With effort on Default it uses the temperature above. It always
              knows the brief, story beats, speakers and the current section.
            </p>

            <ModelPicker
              label="Vision model — lets /continue look at frames"
              value={draft.visionModel}
              placeholder="Empty: /continue works from the script alone"
              models={models.filter((m) => m.vision)}
              onChange={(id) => set("visionModel", id)}
            />
            <p className="hint">
              During a /continue run the model can grab a frame from the video and
              have this model describe it, to fit its lines to what is on screen.
              The list shows only models that take images. Frames are sent to
              OpenRouter and the model's provider. A cheap, fast model is plenty;
              descriptions are treated as hints, and a refusal is simply skipped.
            </p>
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
            <legend>Subtitle export</legend>
            <label className="field checkbox">
              <input
                type="checkbox"
                checked={draft.srtSpeakerColors}
                onChange={(e) => set("srtSpeakerColors", e.target.checked)}
              />
              <span>Write speaker colours into exported .srt</span>
            </label>
            <p className="hint">
              Wraps each cue in <code>&lt;font color="…"&gt;</code>, which most players
              honour and this app reads back as speakers on import. Turn it off for a
              plain .srt. The .ass export always carries speaker colours.
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
              <label className="field">
                <span>Target reading speed (characters per second)</span>
                <input
                  type="number"
                  min={5}
                  max={30}
                  step={1}
                  value={draft.targetCps}
                  onChange={(e) => set("targetCps", Number(e.target.value))}
                />
              </label>
            </div>
            <p className="hint">
              Cues may not overlap: edits are clamped to leave the gap above. The two
              limits only flag a cue in the list; nothing is rewritten for you. R
              retimes the selected cues to the reading speed, and a pasted cue is
              timed by it.
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
            <legend>Transcription</legend>
            <label className="field">
              <span>Engine path (optional)</span>
              <div className="field-row">
                <input
                  value={draft.whisperEnginePath}
                  placeholder="Downloaded and managed by the app"
                  onChange={(e) => set("whisperEnginePath", e.target.value)}
                />
                <button
                  type="button"
                  onClick={async () => {
                    const picked = await openDialog({
                      multiple: false,
                      filters: [
                        { name: "Faster-Whisper-XXL", extensions: ["exe"] },
                      ],
                    });
                    if (typeof picked === "string") set("whisperEnginePath", picked);
                  }}
                >
                  Browse…
                </button>
              </div>
            </label>
            <p className="hint">
              Leave this empty and File ▸ Transcribe… will download Faster-Whisper-XXL
              for you. Set it only if you have unpacked the engine yourself — point it
              at <code>faster-whisper-xxl.exe</code>. A path set here wins over the
              downloaded copy.
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
              // An override that is off, or still word for word the built-in text,
              // is stored as none — so improvements to the built-in text reach it.
              const override = draft.fillGuidanceOverride.trim();
              const unchanged =
                !overridingGuidance || override === DEFAULT_FILL_GUIDANCE.trim();
              onSave({ ...draft, fillGuidanceOverride: unchanged ? "" : draft.fillGuidanceOverride });
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

/** The models the chat panel offers, in order, and a picker to add more. */
function ChatModelList({
  value,
  models,
  onChange,
}: {
  value: string[];
  models: ModelInfo[];
  onChange: (ids: string[]) => void;
}) {
  const [pending, setPending] = useState("");
  const id = pending.trim();
  const canAdd = id !== "" && !value.includes(id);

  const add = () => {
    if (!canAdd) return;
    onChange([...value, id]);
    setPending("");
  };

  const moveUp = (index: number) =>
    onChange(value.map((m, i) => (i === index - 1 ? value[index] : i === index ? value[index - 1] : m)));

  return (
    <>
      <div className="field">
        <span>Chat models</span>
        {value.length === 0 ? (
          <p className="hint">None yet — add one below to use the chat.</p>
        ) : (
          <ul className="chat-model-list">
            {value.map((m, i) => (
              <li key={m}>
                <code>{m}</code>
                <button
                  type="button"
                  className="icon-button"
                  title="Move up"
                  disabled={i === 0}
                  onClick={() => moveUp(i)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title="Remove"
                  onClick={() => onChange(value.filter((other) => other !== m))}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ModelPicker
        label="Add a chat model"
        value={pending}
        placeholder="openai/gpt-5"
        models={models}
        onChange={setPending}
      />
      <div className="field-row">
        <button type="button" disabled={!canAdd} onClick={add}>
          Add model
        </button>
        {id !== "" && !canAdd && <span className="hint">Already in the list.</span>}
      </div>
    </>
  );
}

/** A model id field, with a filter over OpenRouter's catalogue to pick from. */
function ModelPicker({
  label,
  value,
  placeholder,
  models,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  models: ModelInfo[];
  disabled?: boolean;
  onChange: (id: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const visible = models
    .filter((m) => m.id.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, 60);

  return (
    <>
      <label className="field">
        <span>{label}</span>
        <input
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      </label>

      <label className="field">
        <span>Filter the model list</span>
        <input
          value={filter}
          disabled={disabled}
          placeholder={models.length ? `${models.length} models available` : "loading…"}
          onChange={(e) => setFilter(e.target.value)}
        />
      </label>

      {filter && !disabled && (
        <div className="model-list">
          {visible.map((m) => (
            <button
              key={m.id}
              type="button"
              className={m.id === value ? "model selected" : "model"}
              onClick={() => onChange(m.id)}
            >
              <strong>{m.id}</strong>
              <span>{m.name}</span>
            </button>
          ))}
          {visible.length === 0 && <p className="hint">No model ids match that filter.</p>}
        </div>
      )}
    </>
  );
}
