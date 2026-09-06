import { useEffect, useMemo, useRef, useState } from "react";
import type { Cue, GeneratedLine, Settings, Speaker } from "../types";
import { aiContinueScene, aiStoryBeats, errorMessage } from "../lib/api";
import { contextBefore } from "../lib/cues";
import { ContextPreview } from "./ContextPreview";

/** An exchange needs someone to exchange with. */
const MIN_SPEAKERS = 2;
const MIN_LINES = 2;
const MAX_LINES = 8;

interface Props {
  cues: Cue[];
  speakers: Speaker[];
  selectedCueId: string | null;
  settings: Settings;
  /** The story's core beats, one per entry. Lives in the project. */
  beats: string[];
  onBeatsChange: (beats: string[], mergeKey?: string) => void;
  onAccept: (text: string, speakerId: string | null) => void;
  /** Inserts a whole exchange in one step. False when there was no room. */
  onAcceptAll: (lines: Array<{ text: string; speakerId: string | null }>) => boolean;
  /** Asks the user to confirm before something is overwritten. */
  onConfirm: (question: string) => Promise<boolean>;
  /** Registers the generate handler so Ctrl+G can trigger it. */
  registerGenerate: (fn: (() => void) | null) => void;
}

/** A line the user can still edit and re-attribute before accepting it. */
interface DraftLine {
  key: string;
  text: string;
  speakerId: string | null;
}

/**
 * Several lines at once, written toward the story's beats. The beats are the
 * whole point: without them a continuation can only extend the local texture of
 * the conversation, never carry it anywhere.
 */
export function ContinueSceneTab({
  cues,
  speakers,
  selectedCueId,
  settings,
  beats,
  onBeatsChange,
  onAccept,
  onAcceptAll,
  onConfirm,
  registerGenerate,
}: Props) {
  const [lineCount, setLineCount] = useState(4);
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [beatsBusy, setBeatsBusy] = useState(false);
  const [beatsError, setBeatsError] = useState<string | null>(null);

  const context = useMemo(
    () => contextBefore(cues, selectedCueId, settings.contextLines),
    [cues, selectedCueId, settings.contextLines],
  );

  const nameOf = (id: string | null) =>
    speakers.find((s) => s.id === id)?.name ?? "—";

  /** The model answers with names; ids are ours alone. */
  const speakerIdFor = (name: string): string | null => {
    const wanted = name.trim().toLowerCase();
    if (!wanted) return null;
    return speakers.find((s) => s.name.trim().toLowerCase() === wanted)?.id ?? null;
  };

  const enoughSpeakers = speakers.length >= MIN_SPEAKERS;
  const canGenerate = !busy && enoughSpeakers;

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const lines: GeneratedLine[] = await aiContinueScene({
        model: settings.model,
        temperature: settings.temperature,
        lineCount,
        styleNotes: settings.styleNotes,
        beats,
        speakers: speakers.map((s) => ({
          name: s.name,
          voiceNotes: s.voiceNotes ?? "",
        })),
        context: context.map((cue) => ({
          speaker: nameOf(cue.speakerId),
          text: cue.text,
        })),
      });
      setDraft(
        lines.map((line, i) => ({
          key: `${i}-${line.text.slice(0, 12)}`,
          text: line.text,
          speakerId: speakerIdFor(line.speaker),
        })),
      );
    } catch (e) {
      setError(errorMessage(e));
      setDraft([]);
    } finally {
      setBusy(false);
    }
  };

  const generateBeats = async () => {
    const hasBeats = beats.some((beat) => beat.trim() !== "");
    if (hasBeats) {
      const go = await onConfirm(
        "Replace the story beats with a freshly generated outline?",
      );
      if (!go) return;
    }

    setBeatsBusy(true);
    setBeatsError(null);
    try {
      const generated = await aiStoryBeats({
        model: settings.model,
        cues: cues.map((cue) => ({
          speaker: nameOf(cue.speakerId),
          text: cue.text,
        })),
      });
      onBeatsChange(generated);
    } catch (e) {
      setBeatsError(errorMessage(e));
    } finally {
      setBeatsBusy(false);
    }
  };

  // Routed through a ref so the registration does not churn on every keystroke.
  const generateRef = useRef(generate);
  generateRef.current = generate;

  useEffect(() => {
    registerGenerate(canGenerate ? () => generateRef.current() : null);
    return () => registerGenerate(null);
  }, [canGenerate, registerGenerate]);

  const drop = (key: string) =>
    setDraft((list) => list.filter((line) => line.key !== key));

  const acceptOne = (line: DraftLine) => {
    onAccept(line.text.trim(), line.speakerId);
    drop(line.key);
  };

  const acceptAll = () => {
    const lines = draft
      .filter((line) => line.text.trim() !== "")
      .map((line) => ({ text: line.text.trim(), speakerId: line.speakerId }));
    if (onAcceptAll(lines)) setDraft([]);
  };

  return (
    <div className="panel-body">
      <details className="beats" open>
        <summary>
          <span>Story beats</span>
          <button
            type="button"
            className="beats-generate"
            disabled={beatsBusy || cues.length === 0}
            onClick={(e) => {
              // Inside a <summary>, a click would toggle the disclosure too.
              e.preventDefault();
              void generateBeats();
            }}
          >
            {beatsBusy ? "Reading the script…" : "Generate"}
          </button>
        </summary>
        <textarea
          className="beats-input"
          value={beats.join("\n")}
          rows={6}
          placeholder={"One beat per line, e.g.\nAnna suspects Ben took the money"}
          onChange={(e) => onBeatsChange(e.target.value.split("\n"), "beats")}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <p className="hint">
          One beat per line. Written by hand, or generated from the whole script.
          Saved with the project.
        </p>
        {beatsError && <p className="error">{beatsError}</p>}
      </details>

      <label className="field">
        <span>Lines to write</span>
        <input
          type="number"
          min={MIN_LINES}
          max={MAX_LINES}
          value={lineCount}
          onChange={(e) =>
            setLineCount(
              Math.min(MAX_LINES, Math.max(MIN_LINES, Number(e.target.value) || MIN_LINES)),
            )
          }
        />
      </label>

      <ContextPreview context={context} speakers={speakers} />

      <button
        type="button"
        className="primary"
        disabled={!canGenerate}
        onClick={generate}
      >
        {busy ? "Writing…" : draft.length ? "Rewrite" : "Continue"}
      </button>

      {!enoughSpeakers && (
        <p className="hint">
          Add at least {MIN_SPEAKERS} speakers — an exchange needs someone to
          answer.
        </p>
      )}

      {error && <p className="error">{error}</p>}

      {draft.length > 0 && (
        <div className="candidates">
          {draft.map((line) => (
            <div className="scene-line" key={line.key}>
              <select
                value={line.speakerId ?? ""}
                onChange={(e) =>
                  setDraft((list) =>
                    list.map((l) =>
                      l.key === line.key
                        ? { ...l, speakerId: e.target.value || null }
                        : l,
                    ),
                  )
                }
              >
                <option value="">—</option>
                {speakers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <textarea
                value={line.text}
                rows={2}
                onChange={(e) =>
                  setDraft((list) =>
                    list.map((l) =>
                      l.key === line.key ? { ...l, text: e.target.value } : l,
                    ),
                  )
                }
                onKeyDown={(e) => e.stopPropagation()}
              />
              <button
                type="button"
                disabled={line.text.trim() === ""}
                onClick={() => acceptOne(line)}
              >
                Accept
              </button>
              <button
                type="button"
                className="icon-button"
                title="Drop this line"
                onClick={() => drop(line.key)}
              >
                ✕
              </button>
            </div>
          ))}
          <button type="button" onClick={acceptAll}>
            Accept all {draft.length} lines
          </button>
          <p className="hint">
            Accepting appends cues after the selection. Set their timing on the
            waveform.
          </p>
        </div>
      )}
    </div>
  );
}
