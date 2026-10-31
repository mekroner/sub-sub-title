import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { CastVoice, ClipTake, Cue, ProjectPaths, TtsEvent, TtsStatus, Voiceover } from "../types";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import { makeId } from "../lib/ids";
import {
  lineIndex,
  newSeed,
  nextLine,
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
 * stopped part way. Lines asked for during a run join it.
 */
export function useVoiceGeneration({ voiceover, cues, paths, commit, notify }: Options) {
  const [status, setStatus] = useState<TtsStatus | null>(null);
  const [job, setJob] = useState<GenerationJob | null>(null);
  const stopRequested = useRef(false);
  const running = useRef(false);
  /**
   * The first cue of each line still to speak. Lines are looked up again when
   * their turn comes, so one edited meanwhile is spoken as it reads then.
   */
  const queue = useRef<string[]>([]);
  /** The first cue of the line being spoken now. */
  const speaking = useRef<string | null>(null);
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

  /** The queued lines as they read now; any that no longer exist are dropped. */
  const resolveQueue = (): Cue[][] => {
    const index = lineIndex(voiceoverRef.current, cuesRef.current);
    const groups: Cue[][] = [];
    for (const id of queue.current) {
      const group = index.groupOf(id);
      if (group && !groups.includes(group) && group[0].id !== speaking.current) groups.push(group);
    }
    queue.current = groups.map((g) => g[0].id);
    return groups;
  };

  /**
   * Speaks the lines the given cues belong to — the whole line, when a cue is
   * one part of a sentence spoken across several. During a run they are added
   * to it, and become part of its undo step.
   */
  const generate = useCallback(
    async (requested: Cue[]) => {
      if (!paths) return;
      const index = lineIndex(voiceoverRef.current, cuesRef.current);
      const added: string[] = [];
      for (const cue of requested) {
        const first = index.groupOf(cue.id)?.[0].id;
        if (first && !added.includes(first) && !queue.current.includes(first) && first !== speaking.current) {
          added.push(first);
        }
      }
      if (added.length === 0) return;
      queue.current = [...queue.current, ...added];

      if (running.current) {
        setJob((current) => current && { ...current, total: current.total + added.length });
        return;
      }

      running.current = true;
      stopRequested.current = false;
      const batch = `tts:${makeId()}`;
      let done = 0;
      let last: Pick<CastVoice, "engine" | "reference"> | null = null;
      setJob({ done, total: added.length, current: "", loading: false });
      try {
        for (;;) {
          if (stopRequested.current) break;
          const pending = resolveQueue();
          if (pending.length === 0) break;
          const group = pending[nextLine(voiceoverRef.current, pending, last)];
          queue.current = queue.current.filter((id) => id !== group[0].id);
          speaking.current = group[0].id;

          const line = renderGroup(voiceoverRef.current, group);
          setJob(
            (current) =>
              current && {
                ...current,
                current: line.text || speechText(group[0]),
                total: done + pending.length,
              },
          );
          const { voice } = line;
          last = voice;
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
          speaking.current = null;
          done += 1;
          setJob((current) => current && { ...current, done });
        }
        const total = done + queue.current.length;
        if (stopRequested.current && done < total) {
          notify(`Stopped after ${done} of ${total} lines.`);
        } else if (done > 1) {
          notify(`Spoke ${done} lines.`);
        }
      } catch (e) {
        const total = done + queue.current.length + 1;
        notify(
          `${done > 0 ? `Stopped after ${done} of ${total} lines: ` : ""}${errorMessage(e)}`,
          "error",
        );
      } finally {
        queue.current = [];
        speaking.current = null;
        running.current = false;
        setJob(null);
      }
    },
    [paths, commit, notify],
  );

  const stop = useCallback(() => {
    stopRequested.current = true;
  }, []);

  return { status, refreshStatus, job, generate, stop };
}
