import { useEffect, useMemo, useRef, useState } from "react";
import type { Cue, FillLatitude, Section, Settings, Speaker, TimedBeat } from "../types";
import { aiFill, aiStoryBeats, errorMessage } from "../lib/api";
import {
  LATITUDE_LABELS,
  MAX_CONTINUE_LINES,
  MAX_TAKES,
  MIN_CONTINUE_LINES,
  MIN_TAKES,
  buildSlots,
  buildSystemPrompt,
  buildTranscript,
  buildUserPrompt,
  continueWindow,
  defaultSetupFor,
  isLatitude,
  maxTokensFor,
  parseFillReply,
  resolveLine,
  scenesIn,
} from "../lib/fill";
import type {
  DraftHandling,
  FillSlot,
  FillTarget,
  PromptInput,
  SlotMode,
  SlotSetup,
  Take,
  TranscriptItem,
} from "../lib/fill";
import { formatShort } from "../lib/time";

/** A line ready to land, as the writer left it. */
export interface FilledLine {
  text: string;
  speakerId: string | null;
  mode: "spoken" | "thought";
}

export type AcceptedFill =
  | { kind: "fill"; lines: Array<FilledLine & { cueId: string }> }
  | { kind: "continue"; window: { start: number; end: number }; lines: FilledLine[] };

interface Props {
  /** The selected cues, in time order. Empty when nothing is selected. */
  selectedCueIds: string[];
  /** Where continue mode writes from: the selection's end, or the playhead. */
  continueAfter: number;
  initialKind: FillTarget["kind"];
  cues: Cue[];
  speakers: Speaker[];
  sections: Section[];
  brief: string;
  beats: string[];
  /** Planned beats in the stretch Fill writes go along with the request. */
  timedBeats: TimedBeat[];
  settings: Settings;
  duration: number;
  apiKeySet: boolean;
  onBriefChange: (brief: string) => void;
  onBeatsChange: (beats: string[], mergeKey?: string) => void;
  onSpeakerChange: (id: string, patch: Partial<Speaker>) => void;
  onSectionNoteChange: (id: string, note: string) => void;
  /** Persists the dialog's own preferences — takes, latitude, context size. */
  onSettingsChange: (patch: Partial<Settings>) => void;
  onConfirm: (question: string) => Promise<boolean>;
  /** Lands the lines. False when they could not be placed; the dialog stays open. */
  onAccept: (fill: AcceptedFill) => boolean;
  onOpenSettings: () => void;
  onClose: () => void;
}

/** The line chosen for one slot, and which take it came from, if unedited. */
interface Choice extends FilledLine {
  take: number | null;
}

const RECENT_KEY = "sub-sub-title:fillDirections";
const RECENT_LIMIT = 10;

function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

function rememberRecent(direction: string): string[] {
  const next = [direction, ...readRecent().filter((d) => d !== direction)].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // A lost history entry is not worth an error.
  }
  return next;
}

const takeLetter = (index: number) => String.fromCharCode(65 + index);
const charCount = (text: string) => text.replace(/\s+/g, " ").trim().length;

/**
 * Writes dialogue into slots. The left column is everything the model will
 * read — brief, beats, characters, scene notes, the transcript and the exact
 * prompt — and is edited in place. The right column is what the writer wants
 * this time: the slots, a direction, how far to stray, and how many takes.
 */
export function FillDialog({
  selectedCueIds,
  continueAfter,
  initialKind,
  cues,
  speakers,
  sections,
  brief,
  beats,
  timedBeats,
  settings,
  duration,
  apiKeySet,
  onBriefChange,
  onBeatsChange,
  onSpeakerChange,
  onSectionNoteChange,
  onSettingsChange,
  onConfirm,
  onAccept,
  onOpenSettings,
  onClose,
}: Props) {
  const canFill = selectedCueIds.length > 0;
  const [kind, setKind] = useState<FillTarget["kind"]>(canFill ? initialKind : "continue");
  const [continueCount, setContinueCount] = useState(2);

  // Snapshotted at open: editing a cue's speaker later must not reset the setup.
  const [fillSetups, setFillSetups] = useState<SlotSetup[]>(() => {
    const wanted = new Set(selectedCueIds);
    return cues.filter((c) => wanted.has(c.id)).map(defaultSetupFor);
  });
  const [continueSetups, setContinueSetups] = useState<SlotSetup[]>([]);

  const [direction, setDirection] = useState("");
  const [recent, setRecent] = useState<string[]>(readRecent);
  const [drafts, setDrafts] = useState<DraftHandling>("complete");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawReply, setRawReply] = useState<string | null>(null);
  const [takes, setTakes] = useState<Take[]>([]);
  /** The slots the takes were written for, so a later setup change cannot misalign them. */
  const [takeSlots, setTakeSlots] = useState<FillSlot[]>([]);
  const [choices, setChoices] = useState<Array<Choice | null>>([]);

  const [beatsBusy, setBeatsBusy] = useState(false);
  const [beatsError, setBeatsError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // A reply that arrives after the dialog closed has nowhere to go.
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);

  const latitude: FillLatitude = isLatitude(settings.fillLatitude)
    ? settings.fillLatitude
    : "open";
  const takeCount = Math.min(MAX_TAKES, Math.max(MIN_TAKES, settings.fillTakes || 3));

  const limits = {
    targetCps: settings.targetCps,
    maxCharsPerLine: settings.maxCharsPerLine,
    maxLines: settings.maxLines,
  };

  const target: FillTarget =
    kind === "fill"
      ? { kind: "fill", cueIds: selectedCueIds }
      : { kind: "continue", after: continueAfter, count: continueCount };

  const slotWindow = useMemo(
    () =>
      kind === "continue"
        ? continueWindow(cues, continueAfter, duration, settings.minGap)
        : null,
    [kind, cues, continueAfter, duration, settings.minGap],
  );

  const setups = kind === "fill" ? fillSetups : continueSetups;
  const slots = buildSlots(target, cues, setups, limits, slotWindow, settings.minGap);

  const transcript = buildTranscript(
    cues,
    slots,
    sections,
    settings.fillLinesBefore,
    settings.fillLinesAfter,
    slotWindow,
  );

  const promptInput: PromptInput = {
    target,
    slots,
    transcript,
    speakers,
    brief,
    beats,
    timedBeats,
    direction,
    latitude,
    drafts,
    takes: takeCount,
    guidanceOverride: settings.fillGuidanceOverride,
    instructions: settings.fillInstructions,
  };
  const system = buildSystemPrompt(promptInput);
  const user = buildUserPrompt(promptInput);
  const scenes = scenesIn(transcript);

  const updateSetup = (index: number, patch: Partial<SlotSetup>) => {
    const apply = (list: SlotSetup[]) => {
      const next = [...list];
      const slot = slots[index];
      next[index] = {
        speakerId: slot?.speakerId ?? null,
        mode: slot?.mode ?? "choose",
        ...patch,
      };
      return next;
    };
    if (kind === "fill") setFillSetups(apply);
    else setContinueSetups(apply);
  };

  const clearResults = () => {
    setTakes([]);
    setTakeSlots([]);
    setChoices([]);
    setRawReply(null);
  };

  const switchKind = (next: FillTarget["kind"]) => {
    if (next === kind) return;
    setKind(next);
    clearResults();
    setError(null);
  };

  /** The line a take offers for one slot, resolved against what the slot fixed. */
  const choiceFrom = (takeIndex: number, slotIndex: number): Choice | null => {
    const line = takes[takeIndex]?.lines[slotIndex];
    const slot = takeSlots[slotIndex];
    if (!line || !slot) return null;
    return { text: line.text, take: takeIndex, ...resolveLine(slot, line, speakers) };
  };

  const generate = async () => {
    if (busy || !apiKeySet || slots.length === 0) return;
    setBusy(true);
    setError(null);
    setRawReply(null);

    const sentSlots = slots;
    if (direction.trim()) setRecent(rememberRecent(direction.trim()));

    let reply = "";
    try {
      reply = await aiFill({
        model: settings.model,
        temperature: settings.temperature,
        maxTokens: maxTokensFor(sentSlots.length, takeCount),
        system,
        user,
      });
      if (!mounted.current) return;
      const parsed = parseFillReply(reply, sentSlots.length);
      setTakes(parsed);
      setTakeSlots(sentSlots);
      setChoices(
        sentSlots.map((slot, i) => {
          const line = parsed[0].lines[i];
          return line ? { text: line.text, take: 0, ...resolveLine(slot, line, speakers) } : null;
        }),
      );
    } catch (e) {
      if (!mounted.current) return;
      setError(errorMessage(e));
      // Only worth showing when the model answered but the answer was unreadable.
      if (reply) setRawReply(reply);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const pickTake = (takeIndex: number) =>
    setChoices(takeSlots.map((_, i) => choiceFrom(takeIndex, i) ?? choices[i] ?? null));

  const updateChoice = (index: number, patch: Partial<Choice>) =>
    setChoices((list) => {
      const next = [...list];
      const current = next[index] ?? {
        text: "",
        take: null,
        speakerId: takeSlots[index]?.speakerId ?? null,
        mode: takeSlots[index]?.mode === "thought" ? "thought" : "spoken",
      };
      next[index] = { ...current, ...patch };
      return next;
    });

  const accept = () => {
    const ready = choices.map((c) => (c && c.text.trim() ? c : null));
    if (ready.every((c) => c === null)) return;

    let landed: boolean;
    if (kind === "fill") {
      const lines = takeSlots.flatMap((slot, i) => {
        const choice = ready[i];
        return choice && slot.cueId
          ? [{ cueId: slot.cueId, text: choice.text.trim(), speakerId: choice.speakerId, mode: choice.mode }]
          : [];
      });
      landed = onAccept({ kind: "fill", lines });
    } else {
      const lines = ready
        .filter((c): c is Choice => c !== null)
        .map(({ text, speakerId, mode }) => ({ text: text.trim(), speakerId, mode }));
      landed = onAccept({ kind: "continue", window: slotWindow ?? { start: 0, end: Infinity }, lines });
    }
    if (landed) onClose();
  };

  const generateBeats = async () => {
    if (beats.some((b) => b.trim())) {
      const go = await onConfirm("Replace the story beats with a freshly generated outline?");
      if (!go) return;
    }
    setBeatsBusy(true);
    setBeatsError(null);
    try {
      const generated = await aiStoryBeats({
        model: settings.model,
        cues: cues.map((cue) => ({
          speaker: speakers.find((s) => s.id === cue.speakerId)?.name ?? "",
          text: cue.mode === "thought" ? `(thinks) ${cue.text}` : cue.text,
        })),
      });
      if (mounted.current) onBeatsChange(generated);
    } catch (e) {
      if (mounted.current) setBeatsError(errorMessage(e));
    } finally {
      if (mounted.current) setBeatsBusy(false);
    }
  };

  const copyPrompt = () => {
    void navigator.clipboard
      .writeText(`=== SYSTEM ===\n${system}\n\n=== USER ===\n${user}`)
      .then(() => {
        setCopied(true);
        setTimeout(() => mounted.current && setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  const hasResults = takes.length > 0;
  const acceptable = choices.some((c) => c && c.text.trim());
  const anyDraft = slots.some((s) => s.draft);
  const noRoom =
    kind === "continue" && slotWindow !== null && slotWindow.end - slotWindow.start < 0.5;

  return (
    // A stray click outside must not throw away takes that cost a request.
    <div className="modal-backdrop" onMouseDown={busy || hasResults ? undefined : onClose}>
      <div
        className="modal fill-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void generate();
          }
        }}
      >
        <header className="modal-header">
          <h2>{kind === "fill" ? "Fill" : "Continue"}</h2>
          <div className="segmented">
            <button
              type="button"
              className={kind === "fill" ? "on" : ""}
              disabled={!canFill}
              title={canFill ? undefined : "Select the cues to fill first"}
              onClick={() => switchKind("fill")}
            >
              Fill {selectedCueIds.length} selected
            </button>
            <button
              type="button"
              className={kind === "continue" ? "on" : ""}
              onClick={() => switchKind("continue")}
            >
              Continue after {formatShort(continueAfter)}
            </button>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="fill-columns">
          {/* ---- Context: what the model reads ---- */}
          <section className="fill-column">
            <h3 className="fill-heading">Context</h3>

            <label className="field">
              <span>Project brief — premise, tone, world</span>
              <textarea
                rows={4}
                value={brief}
                placeholder="e.g. A dry Nordic comedy. Anna and Ben run a failing ferry café; neither will admit they want out."
                onChange={(e) => onBriefChange(e.target.value)}
              />
            </label>

            <div className="field">
              <div className="field-label-row">
                <span>Story beats — one per line</span>
                <button
                  type="button"
                  className="small"
                  disabled={beatsBusy || !apiKeySet || cues.length === 0}
                  onClick={() => void generateBeats()}
                >
                  {beatsBusy ? "Reading the script…" : "Generate from script"}
                </button>
              </div>
              <textarea
                rows={4}
                value={beats.join("\n")}
                placeholder={"Ben lies about where he was\nAnna finds the receipt"}
                onChange={(e) => onBeatsChange(e.target.value.split("\n"), "beats")}
              />
              {beatsError && <p className="error">{beatsError}</p>}
            </div>

            <details className="fill-details" open={speakers.length <= 4}>
              <summary>Characters ({speakers.length})</summary>
              {speakers.length === 0 && (
                <p className="hint">No speakers yet — add them in the Speakers panel.</p>
              )}
              {speakers.map((speaker) => (
                <div className="fill-character" key={speaker.id}>
                  <div className="fill-character-name">
                    <span className="swatch" style={{ background: speaker.color }} aria-hidden />
                    {speaker.name || "Unnamed"}
                  </div>
                  <textarea
                    rows={2}
                    value={speaker.voiceNotes ?? ""}
                    placeholder="Voice — how they talk"
                    onChange={(e) => onSpeakerChange(speaker.id, { voiceNotes: e.target.value })}
                  />
                  <textarea
                    rows={2}
                    value={speaker.innerVoice ?? ""}
                    placeholder="Inner voice — how they think, if it differs"
                    onChange={(e) => onSpeakerChange(speaker.id, { innerVoice: e.target.value })}
                  />
                </div>
              ))}
            </details>

            <div className="field">
              <span className="field-caption">Scene notes</span>
              {scenes.length === 0 ? (
                <p className="hint">
                  No sections cover this passage. Press <kbd>B</kbd> on the timeline to flag
                  a scene, and its note will steer the lines here.
                </p>
              ) : (
                scenes.map((section) => (
                  <label className="fill-scene" key={section.id}>
                    <span>{section.label || "Untitled"} · {formatShort(section.start)}</span>
                    <textarea
                      rows={2}
                      value={section.note ?? ""}
                      placeholder="What is going on here — who wants what, what just changed"
                      onChange={(e) => onSectionNoteChange(section.id, e.target.value)}
                    />
                  </label>
                ))
              )}
            </div>

            <div className="field">
              <div className="field-label-row">
                <span>Transcript</span>
                <label className="inline-number">
                  before
                  <input
                    type="number"
                    min={0}
                    max={200}
                    value={settings.fillLinesBefore}
                    onChange={(e) =>
                      onSettingsChange({ fillLinesBefore: Math.max(0, Number(e.target.value) || 0) })
                    }
                  />
                </label>
                <label className="inline-number">
                  after
                  <input
                    type="number"
                    min={0}
                    max={50}
                    value={settings.fillLinesAfter}
                    onChange={(e) =>
                      onSettingsChange({ fillLinesAfter: Math.max(0, Number(e.target.value) || 0) })
                    }
                  />
                </label>
              </div>
              <TranscriptView items={transcript} speakers={speakers} />
            </div>

            <details className="fill-details">
              <summary>Exact prompt</summary>
              <div className="field-label-row">
                <span className="hint">
                  What is sent, as it stands. The writing guidance can be changed in Settings.
                </span>
                <button type="button" className="small" onClick={copyPrompt}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="fill-prompt">
                {"=== SYSTEM ===\n"}
                {system}
                {"\n\n=== USER ===\n"}
                {user}
              </pre>
            </details>
          </section>

          {/* ---- Direction: what the writer wants this time ---- */}
          <section className="fill-column">
            <h3 className="fill-heading">Direction</h3>

            {!apiKeySet && (
              <div className="fill-banner">
                <span>No OpenRouter API key saved yet.</span>
                <button type="button" className="small" onClick={onOpenSettings}>
                  Open Settings
                </button>
              </div>
            )}

            {kind === "continue" && (
              <label className="field">
                <span>New lines to write</span>
                <input
                  type="number"
                  min={MIN_CONTINUE_LINES}
                  max={MAX_CONTINUE_LINES}
                  value={continueCount}
                  onChange={(e) => {
                    const count = Math.min(
                      MAX_CONTINUE_LINES,
                      Math.max(MIN_CONTINUE_LINES, Number(e.target.value) || MIN_CONTINUE_LINES),
                    );
                    setContinueCount(count);
                    clearResults();
                  }}
                />
              </label>
            )}
            {noRoom && (
              <p className="error">
                There is no room after {formatShort(continueAfter)} before the next cue.
              </p>
            )}

            <div className="fill-slots">
              {slots.map((slot, index) => {
                const choice = choices[index] ?? null;
                const resultSlot = takeSlots[index];
                const over = choice ? charCount(choice.text) > (resultSlot?.maxChars ?? slot.maxChars) : false;

                return (
                  <div className="fill-slot" key={`${kind}-${slot.number}`}>
                    <div className="fill-slot-head">
                      <strong>Slot {slot.number}</strong>
                      <span className="hint">
                        {slot.start !== null && slot.end !== null
                          ? `${formatShort(slot.start)} · ${(slot.end - slot.start).toFixed(1)}s · `
                          : "new · "}
                        max {slot.maxChars}
                      </span>
                      <select
                        value={slot.speakerId ?? ""}
                        title="Who says it"
                        onChange={(e) => updateSetup(index, { speakerId: e.target.value || null })}
                      >
                        <option value="">Model picks speaker</option>
                        {speakers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                      <select
                        value={slot.mode}
                        title="Spoken aloud, or thought"
                        onChange={(e) => updateSetup(index, { mode: e.target.value as SlotMode })}
                      >
                        <option value="spoken">Says</option>
                        <option value="thought">Thinks</option>
                        <option value="choose">Model decides</option>
                      </select>
                    </div>

                    {slot.draft && !hasResults && (
                      <p className="fill-draft">Draft: {slot.draft}</p>
                    )}

                    {hasResults && (
                      <>
                        <div className="fill-choice">
                          <select
                            value={choice?.speakerId ?? ""}
                            onChange={(e) =>
                              updateChoice(index, { speakerId: e.target.value || null })
                            }
                          >
                            <option value="">No speaker</option>
                            {speakers.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className={choice?.mode === "thought" ? "mode-toggle on" : "mode-toggle"}
                            title="Toggle between spoken and thought"
                            onClick={() =>
                              updateChoice(index, {
                                mode: choice?.mode === "thought" ? "spoken" : "thought",
                              })
                            }
                          >
                            {choice?.mode === "thought" ? "Thinks" : "Says"}
                          </button>
                          <textarea
                            rows={2}
                            className={choice?.mode === "thought" ? "thought" : undefined}
                            value={choice?.text ?? ""}
                            placeholder="Nothing for this slot — it will be left as it is"
                            onChange={(e) => updateChoice(index, { text: e.target.value, take: null })}
                          />
                          <span className={over ? "fill-count warn" : "fill-count"}>
                            {charCount(choice?.text ?? "")}/{resultSlot?.maxChars ?? slot.maxChars}
                          </span>
                        </div>
                        <div className="fill-alternatives">
                          {takes.map((take, t) => {
                            const line = take.lines[index];
                            if (!line) return null;
                            return (
                              <button
                                type="button"
                                key={t}
                                className={choice?.take === t ? "fill-alt on" : "fill-alt"}
                                onClick={() => {
                                  const picked = choiceFrom(t, index);
                                  if (picked) updateChoice(index, picked);
                                }}
                              >
                                <b>{takeLetter(t)}</b>
                                {line.mode === "thought" && <i>thinks</i>}
                                <span>{line.text}</span>
                              </button>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="field">
              <div className="field-label-row">
                <span>What should these lines do?</span>
                {recent.length > 0 && (
                  <select
                    className="small"
                    value=""
                    onChange={(e) => e.target.value && setDirection(e.target.value)}
                  >
                    <option value="">Recent…</option>
                    {recent.map((d) => (
                      <option key={d} value={d}>
                        {d.length > 60 ? `${d.slice(0, 60)}…` : d}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <textarea
                rows={4}
                value={direction}
                placeholder="e.g. He tries to charm his way out; she lets him dig the hole deeper. Her thought gives away that she already knows."
                onChange={(e) => setDirection(e.target.value)}
              />
            </div>

            <div className="field">
              <span className="field-caption">Creative latitude</span>
              <div className="segmented wide">
                {(Object.keys(LATITUDE_LABELS) as FillLatitude[]).map((level) => (
                  <button
                    type="button"
                    key={level}
                    className={latitude === level ? "on" : ""}
                    onClick={() => onSettingsChange({ fillLatitude: level })}
                  >
                    {LATITUDE_LABELS[level]}
                  </button>
                ))}
              </div>
            </div>

            <div className="field-grid">
              {anyDraft && (
                <label className="field">
                  <span>Existing text</span>
                  <select
                    value={drafts}
                    onChange={(e) => setDrafts(e.target.value as DraftHandling)}
                  >
                    <option value="complete">Build on it</option>
                    <option value="rewrite">Rewrite freely</option>
                  </select>
                </label>
              )}
              <label className="field">
                <span>Takes</span>
                <input
                  type="number"
                  min={MIN_TAKES}
                  max={MAX_TAKES}
                  value={takeCount}
                  onChange={(e) =>
                    onSettingsChange({
                      fillTakes: Math.min(MAX_TAKES, Math.max(MIN_TAKES, Number(e.target.value) || 1)),
                    })
                  }
                />
              </label>
            </div>

            <button
              type="button"
              className="primary"
              disabled={busy || !apiKeySet || slots.length === 0 || noRoom}
              onClick={() => void generate()}
            >
              {busy ? "Writing…" : hasResults ? "Write again" : "Write"}
              <span className="button-hint">Ctrl+Enter</span>
            </button>

            {error && <p className="error">{error}</p>}
            {rawReply && (
              <details className="fill-details">
                <summary>The model's reply</summary>
                <pre className="fill-prompt">{rawReply}</pre>
              </details>
            )}

            {hasResults && takes.length > 1 && (
              <div className="fill-takes">
                {takes.map((take, t) => (
                  <button type="button" key={t} className="small" onClick={() => pickTake(t)}>
                    Use take {takeLetter(t)}
                    {take.approach && <span className="hint"> — {take.approach}</span>}
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>

        <footer className="modal-footer">
          <span className="hint footer-note">
            {settings.model || "No model selected"} · temperature {settings.temperature}
          </span>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={!acceptable} onClick={accept}>
            {kind === "fill" ? "Fill cues" : "Add lines"}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** The transcript as the model reads it, styled so slots and thoughts stand out. */
function TranscriptView({ items, speakers }: { items: TranscriptItem[]; speakers: Speaker[] }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const firstSlotRef = useRef<HTMLDivElement | null>(null);

  // Open on the slots, not on the oldest line of context.
  useEffect(() => {
    const box = scrollRef.current;
    const slot = firstSlotRef.current;
    if (box && slot) box.scrollTop = Math.max(0, slot.offsetTop - box.clientHeight / 3);
  }, []);

  let firstSlotSeen = false;
  return (
    <div className="fill-transcript" ref={scrollRef}>
      {items.length === 0 && <p className="hint">No dialogue around these slots.</p>}
      {items.map((item, i) => {
        switch (item.kind) {
          case "scene":
            return (
              <div className="ft-scene" key={i}>
                {item.section.label || "Untitled scene"}
              </div>
            );
          case "pause":
            return (
              <div className="ft-pause" key={i}>
                pause {item.seconds.toFixed(1)}s
              </div>
            );
          case "line": {
            const speaker = speakers.find((s) => s.id === item.cue.speakerId);
            const thought = item.cue.mode === "thought";
            return (
              <div className={thought ? "ft-line thought" : "ft-line"} key={i}>
                <span className="ft-time">{formatShort(item.cue.start)}</span>
                <span className="ft-who" style={{ color: speaker?.color }}>
                  {speaker?.name ?? "—"}
                  {thought && <i> thinks</i>}
                </span>
                <span className="ft-text">{item.cue.text.replace(/\s+/g, " ") || "…"}</span>
              </div>
            );
          }
          case "slot": {
            const isFirst = !firstSlotSeen;
            firstSlotSeen = true;
            const speaker = speakers.find((s) => s.id === item.slot.speakerId);
            return (
              <div className="ft-line slot" key={i} ref={isFirst ? firstSlotRef : undefined}>
                <span className="ft-time">
                  {item.slot.start !== null ? formatShort(item.slot.start) : "new"}
                </span>
                <span className="ft-who" style={{ color: speaker?.color }}>
                  {speaker?.name ?? "?"}
                </span>
                <span className="ft-text">
                  Slot {item.slot.number}
                  {item.slot.draft ? ` — “${item.slot.draft}”` : ""}
                </span>
              </div>
            );
          }
        }
      })}
    </div>
  );
}
