import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { CastVoice, Cue, Speaker, TtsStatus, Voiceover } from "../types";
import type { GenerationJob } from "../hooks/useVoiceGeneration";
import { MAX_TAKES_PER_LINE, NO_SPEAKER, castKey, voiceFor, type LineIndex } from "../lib/tts";
import { basename, voiceTracks } from "../lib/voiceover";

interface Props {
  voiceover: Voiceover;
  /** The project's lines and their state, from `lineIndex`. */
  lines: LineIndex;
  speakers: Speaker[];
  status: TtsStatus | null;
  job: GenerationJob | null;
  /** False without a video, which the generated files are kept beside. */
  canGenerate: boolean;
  onInstall: () => void;
  onGenerate: (cues: Cue[]) => void;
  onStop: () => void;
  onSetVoice: (key: string, patch: Partial<CastVoice>) => void;
  /** Sets how a word is said; an empty `spoken` forgets it. */
  onSetPronunciation: (word: string, spoken: string) => void;
  onReferenceFromFile: (key: string) => void;
  onReferenceFromVideo: (key: string) => void;
  /** Starts a direction run: puts `/direct` into the chat. Absent without an API key. */
  onDirect?: () => void;
}

interface Row {
  key: string;
  name: string;
  color: string;
  /** Every cue of this speaker that has something to say. */
  cues: Cue[];
  /** How many lines those cues are spoken in. */
  lines: number;
  /** The first cue of each line that is missing or out of date. */
  pending: Cue[];
  missing: number;
  stale: number;
}

/** Who speaks how: a voice per speaker, and generating their lines. */
export function CastPanel({
  voiceover,
  lines,
  speakers,
  status,
  job,
  canGenerate,
  onInstall,
  onGenerate,
  onStop,
  onSetVoice,
  onSetPronunciation,
  onReferenceFromFile,
  onReferenceFromVideo,
  onDirect,
}: Props) {
  const rows = useMemo<Row[]>(() => {
    // Counted in lines, not cues: a sentence spoken across two cues is one
    // line to generate.
    const byKey = new Map<string, Cue[][]>();
    for (const group of lines.groups) {
      const key = castKey(group[0]);
      byKey.set(key, [...(byKey.get(key) ?? []), group]);
    }
    const row = (key: string, name: string, color: string): Row => {
      const own = byKey.get(key) ?? [];
      const states = own.map((g) => lines.stateOf(g));
      return {
        key,
        name,
        color,
        cues: own.flat(),
        lines: own.length,
        pending: own.filter((_, i) => states[i] !== "current").map((g) => g[0]),
        missing: states.filter((s) => s === "missing").length,
        stale: states.filter((s) => s === "stale").length,
      };
    };
    const list = speakers.map((s) => row(s.id, s.name, s.color));
    if (byKey.has(NO_SPEAKER)) list.push(row(NO_SPEAKER, "No speaker", "#5b6b80"));
    return list;
  }, [lines, speakers]);

  // One cue per line is enough: generating a cue speaks its whole line.
  const pending = rows.flatMap((r) => r.pending);
  const installed = status?.installed ?? false;

  return (
    <section className="panel cast-panel">
      <header className="panel-header">
        <h2>Cast</h2>
        <span className="cast-actions">
          {onDirect && (
            <button
              type="button"
              className="small"
              disabled={lines.groups.length === 0}
              onClick={onDirect}
              title="Let the direction agent write a note for every line — puts /direct into the chat"
            >
              ✦ Direct lines
            </button>
          )}
          {installed && (
            <button
              type="button"
              className="small primary"
              disabled={!canGenerate || pending.length === 0}
              onClick={() => onGenerate(pending)}
              title={
                job
                  ? "Add every line that is missing or out of date to this run"
                  : "Speak every line that is missing or out of date"
              }
            >
              Generate {pending.length || ""}
            </button>
          )}
        </span>
      </header>

      {!installed ? (
        <div className="cast-install">
          <p className="hint">
            Lines are spoken by a voice model that runs on this computer. It is installed once.
          </p>
          <button type="button" className="small" onClick={onInstall}>
            Install voice engine…
          </button>
        </div>
      ) : (
        job && (
          <div className="cast-job">
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{ width: `${(job.done / Math.max(1, job.total)) * 100}%` }}
              />
            </div>
            <div className="cast-job-row">
              <span className="hint">
                {job.loading
                  ? "Loading the voice model…"
                  : `Line ${Math.min(job.done + 1, job.total)} of ${job.total}` +
                    (job.take ? ` · take ${job.take[0]} of ${job.take[1]}` : "")}
              </span>
              <button type="button" className="small" onClick={onStop}>
                Stop
              </button>
            </div>
            <span className="cast-job-line" title={job.current}>
              {job.current}
            </span>
          </div>
        )
      )}

      {installed && status?.needsUpdate && !job && (
        <div className="cast-install">
          <p className="hint">
            An update to the voice engine takes the music and effects out of the lines a voice is
            cloned from.
          </p>
          <button type="button" className="small" onClick={onInstall}>
            Update voice engine…
          </button>
        </div>
      )}

      <div className="cast-list">
        {rows.length === 0 && <p className="hint cast-empty">No cues to speak yet.</p>}
        {rows.map((row) => (
          <CastRow
            key={row.key}
            row={row}
            voice={voiceFor(voiceover, row.key)}
            voiceover={voiceover}
            canGenerate={installed && canGenerate}
            onSetVoice={(patch) => onSetVoice(row.key, patch)}
            onGenerate={() => onGenerate(row.pending)}
            onReferenceFromFile={() => onReferenceFromFile(row.key)}
            onReferenceFromVideo={() => onReferenceFromVideo(row.key)}
          />
        ))}
        <Pronunciations
          pronunciations={voiceover.pronunciations ?? {}}
          onSet={onSetPronunciation}
        />
      </div>
    </section>
  );
}

/**
 * Words every voice gets wrong, and how to say them. Numbers and symbols are
 * already spelled out; this is for names and acronyms.
 */
function Pronunciations({
  pronunciations,
  onSet,
}: {
  pronunciations: Record<string, string>;
  onSet: (word: string, spoken: string) => void;
}) {
  const [word, setWord] = useState("");
  const [spoken, setSpoken] = useState("");
  const entries = Object.entries(pronunciations).sort(([a], [b]) => a.localeCompare(b));
  const add = () => {
    if (!word.trim() || !spoken.trim()) return;
    onSet(word, spoken);
    setWord("");
    setSpoken("");
  };

  return (
    <div className="cast-row pronunciations">
      <div className="cast-row-head">
        <span className="cast-name">Pronunciations</span>
        <span className="cast-count">{entries.length || ""}</span>
      </div>
      <p className="hint">
        Names and acronyms the voices get wrong, spelled as they sound. Numbers and symbols are
        spelled out already.
      </p>
      {entries.map(([w, s]) => (
        <div key={w} className="pronunciation">
          <span className="pronunciation-word" title={w}>
            {w}
          </span>
          <span className="pronunciation-arrow">→</span>
          <span className="pronunciation-spoken" title={s}>
            {s}
          </span>
          <button
            type="button"
            className="icon-button"
            title={`Forget how to say “${w}”`}
            onClick={() => onSet(w, "")}
          >
            ✕
          </button>
        </div>
      ))}
      <form
        className="pronunciation"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          className="pronunciation-word"
          value={word}
          placeholder="Siobhan"
          aria-label="Word"
          onChange={(e) => setWord(e.target.value)}
        />
        <span className="pronunciation-arrow">→</span>
        <input
          className="pronunciation-spoken"
          value={spoken}
          placeholder="shi-VAWN"
          aria-label="Say it as"
          onChange={(e) => setSpoken(e.target.value)}
        />
        <button type="submit" className="small" disabled={!word.trim() || !spoken.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}

function CastRow({
  row,
  voice,
  voiceover,
  canGenerate,
  onSetVoice,
  onGenerate,
  onReferenceFromFile,
  onReferenceFromVideo,
}: {
  row: Row;
  voice: CastVoice;
  voiceover: Voiceover;
  canGenerate: boolean;
  onSetVoice: (patch: Partial<CastVoice>) => void;
  onGenerate: () => void;
  onReferenceFromFile: () => void;
  onReferenceFromVideo: () => void;
}) {
  const todo = row.missing + row.stale;
  const tracks = voiceTracks(voiceover);
  return (
    <div className="cast-row">
      <div className="cast-row-head">
        <span className="cast-swatch" style={{ background: row.color }} />
        <span className="cast-name">{row.name}</span>
        <span className="cast-count" title="Lines spoken / lines">
          {row.lines - todo}/{row.lines}
          {row.stale > 0 && <span className="cast-stale"> · {row.stale} changed</span>}
        </span>
        <button
          type="button"
          className="small"
          disabled={!canGenerate || todo === 0}
          onClick={onGenerate}
          title={`Speak ${row.name}'s ${todo} missing or changed line${todo === 1 ? "" : "s"}`}
        >
          ▶ {todo || ""}
        </button>
      </div>

      <div className="cast-field">
        <span>Voice</span>
        <span className="cast-reference" title={voice.reference ?? "The model's built-in voice"}>
          {voice.reference ? basename(voice.reference) : "Default voice"}
        </span>
        {voice.reference && <PreviewButton file={voice.reference} />}
      </div>
      <div className="cast-actions">
        <button
          type="button"
          className="small"
          disabled={row.cues.length === 0}
          onClick={onReferenceFromVideo}
          title="Choose which of this speaker's lines in the video to clone the voice from"
        >
          From video…
        </button>
        <button type="button" className="small" onClick={onReferenceFromFile} title="Clone a voice from an audio file">
          File…
        </button>
        {voice.reference && (
          <button
            type="button"
            className="small"
            onClick={() => onSetVoice({ reference: undefined })}
            title="Use the model's built-in voice"
          >
            Default
          </button>
        )}
      </div>

      <div className="cast-field">
        <span>Model</span>
        <select
          value={voice.engine}
          onChange={(e) => onSetVoice({ engine: e.target.value as CastVoice["engine"] })}
        >
          <option value="turbo">Turbo — tags like [laugh]</option>
          <option value="standard">Expressive — intensity</option>
        </select>
      </div>
      {voice.engine === "standard" && (
        <label className="cast-field">
          <span>Intensity</span>
          <input
            type="range"
            min={0.25}
            max={2}
            step={0.05}
            value={voice.exaggeration}
            onChange={(e) => onSetVoice({ exaggeration: Number(e.target.value) })}
            onDoubleClick={() => onSetVoice({ exaggeration: 0.5 })}
            title="How theatrical the delivery is — double-click for neutral"
          />
          <span className="cast-value">{voice.exaggeration.toFixed(2)}</span>
        </label>
      )}
      <div className="cast-field">
        <span>Takes</span>
        <select
          value={voice.takesPerLine ?? 1}
          onChange={(e) => {
            const n = Number(e.target.value);
            onSetVoice({ takesPerLine: n > 1 ? n : undefined });
          }}
          title="Speak each line this many times and keep the take that best says it and fits its cue"
        >
          {Array.from({ length: MAX_TAKES_PER_LINE }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n === 1 ? "1 per line" : `Best of ${n}`}
            </option>
          ))}
        </select>
      </div>
      <div className="cast-field">
        <span>Track</span>
        <select
          value={voice.trackId && tracks.some((t) => t.id === voice.trackId) ? voice.trackId : ""}
          onChange={(e) => onSetVoice({ trackId: e.target.value || undefined })}
        >
          <option value="">A free track, picked on its first line</option>
          {tracks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** Plays a reference clip; one at a time across every row. */
let playing: HTMLAudioElement | null = null;

function PreviewButton({ file }: { file: string }) {
  const [on, setOn] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(
    () => () => {
      audio.current?.pause();
    },
    [],
  );
  return (
    <button
      type="button"
      className="icon-button"
      title={on ? "Stop" : "Listen to the reference"}
      onClick={() => {
        if (on && audio.current) {
          audio.current.pause();
          setOn(false);
          return;
        }
        playing?.pause();
        const el = new Audio(convertFileSrc(file));
        el.onended = () => setOn(false);
        el.onpause = () => setOn(false);
        audio.current = el;
        playing = el;
        void el.play().then(() => setOn(true)).catch(() => setOn(false));
      }}
    >
      {on ? "■" : "▶"}
    </button>
  );
}
