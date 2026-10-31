import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ClipTake, Cue, ProjectPaths, TtsEvent, TtsStatus, Voiceover } from "../types";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import { makeId } from "../lib/ids";
import { castKey, newSeed, placeTake, speechText, takePath, voiceFor } from "../lib/tts";

export interface GenerationJob {
  done: number;
  total: number;
  /** The line being spoken now. */
  current: string;
  /** True while a model is being loaded onto the GPU (or first downloaded). */
  loading: boolean;
}

interface Options {
  voiceover: Voiceover;
  paths: ProjectPaths | null;
  /**
   * Applies a placed take. `batch` is the same for every line of one run, so
   * the caller can make the whole run a single undo step.
   */
  commit: (fn: (voiceover: Voiceover) => Voiceover, batch: string) => void;
  notify: (text: string, kind?: "info" | "error") => void;
}

/**
 * Speaking cues through the local voice engine, one line at a time: each take
 * is placed as soon as it exists, so a long run can be watched, played and
 * stopped part way.
 */
export function useVoiceGeneration({ voiceover, paths, commit, notify }: Options) {
  const [status, setStatus] = useState<TtsStatus | null>(null);
  const [job, setJob] = useState<GenerationJob | null>(null);
  const stopRequested = useRef(false);
  // Read when each line is sent, so a voice changed mid-run applies from the
  // next line on.
  const voiceoverRef = useRef(voiceover);
  voiceoverRef.current = voiceover;

  const refreshStatus = useCallback(() => {
    api.ttsStatus().then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(refreshStatus, [refreshStatus]);

  useEffect(() => {
    const unlisten = listen<TtsEvent>("tts-event", ({ payload }) => {
      setJob((current) => current && { ...current, loading: payload.event === "loading" });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const generate = useCallback(
    async (cues: Cue[]) => {
      if (!paths || job) return;
      const lines = cues.filter((cue) => speechText(cue) !== "");
      if (lines.length === 0) return;

      stopRequested.current = false;
      const batch = `tts:${makeId()}`;
      let done = 0;
      setJob({ done, total: lines.length, current: speechText(lines[0]), loading: false });
      try {
        for (const cue of lines) {
          if (stopRequested.current) break;
          const text = speechText(cue);
          setJob((current) => current && { ...current, current: text });
          const voice = voiceFor(voiceoverRef.current, castKey(cue));
          const seed = newSeed();
          const result = await api.ttsGenerate({
            engine: voice.engine,
            text,
            reference: voice.reference ?? null,
            seed,
            exaggeration: voice.exaggeration,
            cfgWeight: voice.cfgWeight,
            temperature: voice.temperature,
            outputPath: takePath(paths.dir, paths.stem, cue.id, seed),
          });
          const take: ClipTake = { file: result.path, seed, duration: result.duration };
          commit((v) => placeTake(v, cue, take), batch);
          done += 1;
          setJob((current) => current && { ...current, done });
        }
        if (stopRequested.current && done < lines.length) {
          notify(`Stopped after ${done} of ${lines.length} lines.`);
        } else if (lines.length > 1) {
          notify(`Spoke ${done} lines.`);
        }
      } catch (e) {
        notify(
          `${done > 0 ? `Stopped after ${done} of ${lines.length} lines: ` : ""}${errorMessage(e)}`,
          "error",
        );
      } finally {
        setJob(null);
      }
    },
    [paths, job, commit, notify],
  );

  const stop = useCallback(() => {
    stopRequested.current = true;
  }, []);

  return { status, refreshStatus, job, generate, stop };
}
