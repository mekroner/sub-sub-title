import { useEffect, useMemo, useRef, useState } from "react";
import type { Cue, Settings, Speaker } from "../types";
import { aiContinue, errorMessage } from "../lib/api";
import { contextBefore } from "../lib/cues";
import { ContextPreview } from "./ContextPreview";

interface Props {
  cues: Cue[];
  speakers: Speaker[];
  selectedCueId: string | null;
  settings: Settings;
  onAccept: (text: string, speakerId: string | null) => void;
  /** Registers the generate handler so Ctrl+G can trigger it. */
  registerGenerate: (fn: (() => void) | null) => void;
}

/** One line for one speaker, from the run of cues before the selection. */
export function ContinueLineTab({
  cues,
  speakers,
  selectedCueId,
  settings,
  onAccept,
  registerGenerate,
}: Props) {
  const [candidates, setCandidates] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetSpeakerId, setTargetSpeakerId] = useState<string | null>(null);
  const [direction, setDirection] = useState("");

  const context = useMemo(
    () => contextBefore(cues, selectedCueId, settings.contextLines),
    [cues, selectedCueId, settings.contextLines],
  );

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
        direction: direction.trim(),
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
  const canGenerate = !busy;
  const generateRef = useRef(generate);
  generateRef.current = generate;

  useEffect(() => {
    registerGenerate(canGenerate ? () => generateRef.current() : null);
    return () => registerGenerate(null);
  }, [canGenerate, registerGenerate]);

  return (
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

      <label className="field">
        <span>Direction for the next line (optional) — Ctrl+Enter to generate</span>
        <textarea
          className="direction-input"
          value={direction}
          rows={2}
          placeholder="e.g. she deflects and changes the subject"
          onChange={(e) => setDirection(e.target.value)}
          onKeyDown={(e) => {
            // Global shortcuts must not fire while typing here.
            e.stopPropagation();
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canGenerate) {
              e.preventDefault();
              void generate();
            }
          }}
        />
      </label>

      <ContextPreview context={context} speakers={speakers} />

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
                setDirection("");
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
