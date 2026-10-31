import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ClipTake, Cue, ProjectPaths, TtsEvent, TtsStatus, Voiceover } from "../types";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import { makeId } from "../lib/ids";
import {
  lineIndex,
  newSeed,
  placeTake,
  proportionalMarks,
  renderGroup,
  renderLine,
  speechText,
  takePath,
} from "../lib/tts";
import { stripTags } from "../lib/direction";

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
  /** Every cue, for working out which cues are spoken together. */
  cues: Cue[];
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
export function useVoiceGeneration({ voiceover, cues, paths, commit, notify }: Options) {
  const [status, setStatus] = useState<TtsStatus | null>(null);
  const [job, setJob] = useState<GenerationJob | null>(null);
  const stopRequested = useRef(false);
  // Read when each line is sent, so a voice changed mid-run applies from the
  // next line on.
  const voiceoverRef = useRef(voiceover);
  voiceoverRef.current = voiceover;
  const cuesRef = useRef(cues);
  cuesRef.current = cues;

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

  /**
   * Speaks the lines the given cues belong to — the whole line, when a cue is
   * one part of a sentence spoken across several.
   */
  const generate = useCallback(
    async (requested: Cue[]) => {
      if (!paths || job) return;
      const index = lineIndex(voiceoverRef.current, cuesRef.current);
      const lines: Cue[][] = [];
      for (const cue of requested) {
        const group = index.groupOf(cue.id);
        if (group && !lines.includes(group)) lines.push(group);
      }
      if (lines.length === 0) return;

      stopRequested.current = false;
      const batch = `tts:${makeId()}`;
      let done = 0;
      setJob({ done, total: lines.length, current: speechText(lines[0][0]), loading: false });
      try {
        for (const group of lines) {
          if (stopRequested.current) break;
          const line = renderGroup(voiceoverRef.current, group);
          setJob((current) => current && { ...current, current: line.text });
          const { voice } = line;
          const seed = newSeed();
          // Each cue's own words, for finding where they fall in the take.
          const parts = group.map((cue) => renderLine(voiceoverRef.current, cue).text);
          const result = await api.ttsGenerate({
            engine: voice.engine,
            text: line.text,
            reference: voice.reference ?? null,
            seed,
            exaggeration: line.exaggeration,
            cfgWeight: voice.cfgWeight,
            temperature: voice.temperature,
            outputPath: takePath(paths.dir, paths.stem, group[0].id, seed),
            alignSegments: group.length > 1 ? parts.map(stripTags) : null,
          });
          const marks =
            group.length > 1
              ? result.marks?.length === group.length
                ? result.marks
                : // Alignment failed or found nothing: an estimate beats none.
                  proportionalMarks(parts, result.duration)
              : undefined;
          const take: ClipTake = {
            file: result.path,
            seed,
            duration: result.duration,
            ...(marks ? { marks } : {}),
          };
          // Records the line as sent, even if its script was edited meanwhile.
          commit((v) => placeTake(v, group, take, line), batch);
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
