import { useEffect, useMemo, useRef, useState } from "react";
import type { Cue, Settings, Speaker } from "../types";
import { aiContinue, errorMessage } from "../lib/api";

interface Props {
  cues: Cue[];
  speakers: Speaker[];
  selectedCueId: string | null;
  settings: Settings;
  apiKeySet: boolean;
  onAccept: (text: string, speakerId: string | null) => void;
  onOpenSettings: () => void;
  /** Registers the generate handler so Ctrl+G can trigger it. */
  registerGenerate: (fn: (() => void) | null) => void;
}

export function ContinuePanel({
  cues,
  speakers,
  selectedCueId,
  settings,
  apiKeySet,
  onAccept,
  onOpenSettings,
  registerGenerate,
}: Props) {
  const [candidates, setCandidates] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetSpeakerId, setTargetSpeakerId] = useState<string | null>(null);

  const selectedIndex = selectedCueId
    ? cues.findIndex((c) => c.id === selectedCueId)
    : cues.length - 1;

  // Context is the run of cues ending at the selection.
  const context = useMemo(() => {
    const end = selectedIndex >= 0 ? selectedIndex + 1 : cues.length;
    const start = Math.max(0, end - settings.contextLines);
    return cues.slice(start, end);
  }, [cues, selectedIndex, settings.contextLines]);

  const nameOf = (id: string | null) =>
    speakers.find((s) => s.id === id)?.name ?? "—";

  // Default target: whoever is not speaking the last line, if there are two.
  const effectiveTargetId = useMemo(() => {
    if (targetSpeakerId) return targetSpeakerId;
    const lastSpeaker = context[context.length - 1]?.speakerId ?? null;
    const other = speakers.find((s) => s.id !== lastSpeaker);
    return other?.id ?? speakers[0]?.id ?? null;
  }, [targetSpeakerId, context, speakers]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const target = speakers.find((s) => s.id === effectiveTargetId) ?? null;
      const result = await aiContinue({
        model: settings.model,
        temperature: settings.temperature,
        candidateCount: settings.candidateCount,
        styleNotes: settings.styleNotes,
        speakerName: target?.name ?? "",
        voiceNotes: target?.voiceNotes ?? "",
        context: context.map((cue) => ({
          speaker: nameOf(cue.speakerId),
          text: cue.text,
        })),
      });
      setCandidates(result);
    } catch (e) {
      setError(errorMessage(e));
      setCandidates([]);
    } finally {
      setBusy(false);
    }
  };

  // Expose the handler to the global shortcut layer. Routed through a ref so the
  // registration does not churn on every keystroke in the panel.
  const canGenerate = apiKeySet && !busy;
  const generateRef = useRef(generate);
  generateRef.current = generate;

  useEffect(() => {
    registerGenerate(canGenerate ? () => generateRef.current() : null);
    return () => registerGenerate(null);
  }, [canGenerate, registerGenerate]);

  return (
    <section className="panel continue-panel">
      <header className="panel-header">
        <h2>Continue</h2>
        <span className="hint">Ctrl+G</span>
      </header>

      {!apiKeySet ? (
        <div className="panel-body">
          <p className="hint">
            No OpenRouter API key saved yet.
          </p>
          <button type="button" onClick={onOpenSettings}>
            Open Settings
          </button>
        </div>
      ) : (
        <div className="panel-body">
          <label className="field">
            <span>Write the next line for</span>
            <select
              value={effectiveTargetId ?? ""}
              onChange={(e) => setTargetSpeakerId(e.target.value || null)}
            >
              {speakers.length === 0 && <option value="">(no speakers yet)</option>}
              {speakers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>

          <div className="context-preview">
            {context.length === 0 ? (
              <p className="hint">No preceding lines to use as context.</p>
            ) : (
              context.map((cue) => (
                <div className="context-line" key={cue.id}>
                  <span
                    className="swatch small"
                    style={{
                      background:
                        speakers.find((s) => s.id === cue.speakerId)?.color ??
                        "transparent",
                    }}
                    aria-hidden
                  />
                  <span className="context-speaker">{nameOf(cue.speakerId)}</span>
                  <span className="context-text">
                    {cue.text.replace(/\n/g, " ")}
                  </span>
                </div>
              ))
            )}
          </div>

          <button
            type="button"
            className="primary"
            disabled={!canGenerate}
            onClick={generate}
          >
            {busy ? "Generating…" : candidates.length ? "Regenerate" : "Generate"}
          </button>

          {error && <p className="error">{error}</p>}

          {candidates.length > 0 && (
            <div className="candidates">
              {candidates.map((text, i) => (
                <Candidate
                  key={`${i}-${text.slice(0, 12)}`}
                  text={text}
                  onAccept={(value) => {
                    onAccept(value, effectiveTargetId);
                    setCandidates([]);
                  }}
                />
              ))}
              <p className="hint">
                Accepting appends a new cue after the selection. Set its timing on the
                waveform.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** A candidate is editable before it is accepted; nothing is auto-inserted. */
function Candidate({
  text,
  onAccept,
}: {
  text: string;
  onAccept: (text: string) => void;
}) {
  const [value, setValue] = useState(text);

  return (
    <div className="candidate">
      <textarea
        value={value}
        rows={2}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <button
        type="button"
        disabled={value.trim() === ""}
        onClick={() => onAccept(value.trim())}
      >
        Accept
      </button>
    </div>
  );
}
