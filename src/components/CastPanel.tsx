import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { CastVoice, Cue, Speaker, TtsStatus, Voiceover } from "../types";
import type { GenerationJob } from "../hooks/useVoiceGeneration";
import { NO_SPEAKER, castKey, lineState, speechText, voiceFor } from "../lib/tts";
import { basename, voiceTracks } from "../lib/voiceover";

interface Props {
  voiceover: Voiceover;
  cues: Cue[];
  speakers: Speaker[];
  status: TtsStatus | null;
  job: GenerationJob | null;
  /** False without a video, which the generated files are kept beside. */
  canGenerate: boolean;
  onInstall: () => void;
  onGenerate: (cues: Cue[]) => void;
  onStop: () => void;
  onSetVoice: (key: string, patch: Partial<CastVoice>) => void;
  onReferenceFromFile: (key: string) => void;
  onReferenceFromVideo: (key: string) => void;
}

interface Row {
  key: string;
  name: string;
  color: string;
  cues: Cue[];
  missing: number;
  stale: number;
}

/** Who speaks how: a voice per speaker, and generating their lines. */
export function CastPanel({
  voiceover,
  cues,
  speakers,
  status,
  job,
  canGenerate,
  onInstall,
  onGenerate,
  onStop,
  onSetVoice,
  onReferenceFromFile,
  onReferenceFromVideo,
}: Props) {
  const rows = useMemo<Row[]>(() => {
    const spoken = cues.filter((c) => speechText(c) !== "");
    const byKey = new Map<string, Cue[]>();
    for (const cue of spoken) {
      const key = castKey(cue);
      byKey.set(key, [...(byKey.get(key) ?? []), cue]);
    }
    const row = (key: string, name: string, color: string): Row => {
      const own = byKey.get(key) ?? [];
      const states = own.map((c) => lineState(voiceover, c));
      return {
        key,
        name,
        color,
        cues: own,
        missing: states.filter((s) => s === "missing").length,
        stale: states.filter((s) => s === "stale").length,
      };
    };
    const list = speakers.map((s) => row(s.id, s.name, s.color));
    if (byKey.has(NO_SPEAKER)) list.push(row(NO_SPEAKER, "No speaker", "#5b6b80"));
    return list;
  }, [cues, speakers, voiceover]);

  const pending = rows.flatMap((r) =>
    r.cues.filter((c) => lineState(voiceover, c) !== "current"),
  );
  const installed = status?.installed ?? false;

  return (
    <section className="panel cast-panel">
      <header className="panel-header">
        <h2>Cast</h2>
        {installed && !job && (
          <button
            type="button"
            className="small primary"
            disabled={!canGenerate || pending.length === 0}
            onClick={() => onGenerate(pending)}
            title="Speak every line that is missing or out of date"
          >
            Generate {pending.length || ""}
          </button>
        )}
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
                  : `Line ${Math.min(job.done + 1, job.total)} of ${job.total}`}
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

      <div className="cast-list">
        {rows.length === 0 && <p className="hint cast-empty">No cues to speak yet.</p>}
        {rows.map((row) => (
          <CastRow
            key={row.key}
            row={row}
            voice={voiceFor(voiceover, row.key)}
            voiceover={voiceover}
            busy={job !== null}
            canGenerate={installed && canGenerate}
            onSetVoice={(patch) => onSetVoice(row.key, patch)}
            onGenerate={() =>
              onGenerate(row.cues.filter((c) => lineState(voiceover, c) !== "current"))
            }
            onReferenceFromFile={() => onReferenceFromFile(row.key)}
            onReferenceFromVideo={() => onReferenceFromVideo(row.key)}
          />
        ))}
      </div>
    </section>
  );
}

function CastRow({
  row,
  voice,
  voiceover,
  busy,
  canGenerate,
  onSetVoice,
  onGenerate,
  onReferenceFromFile,
  onReferenceFromVideo,
}: {
  row: Row;
  voice: CastVoice;
  voiceover: Voiceover;
  busy: boolean;
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
          {row.cues.length - todo}/{row.cues.length}
          {row.stale > 0 && <span className="cast-stale"> · {row.stale} changed</span>}
        </span>
        <button
          type="button"
          className="small"
          disabled={!canGenerate || busy || todo === 0}
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
          title="Clone the voice from this speaker's own lines in the video"
        >
          From video
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
        <span>Track</span>
        <select
          value={voice.trackId && tracks.some((t) => t.id === voice.trackId) ? voice.trackId : ""}
          onChange={(e) => onSetVoice({ trackId: e.target.value || undefined })}
        >
          <option value="">First voice track</option>
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
