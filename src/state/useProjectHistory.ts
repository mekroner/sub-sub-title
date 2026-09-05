import { useCallback, useMemo, useRef, useState } from "react";
import type { Project } from "../types";

const LIMIT = 200;
/** Edits sharing a merge key inside this window collapse into one undo step. */
const MERGE_WINDOW_MS = 700;

interface HistoryState {
  past: Project[];
  present: Project;
  future: Project[];
}

export interface UpdateOptions {
  /**
   * Consecutive updates with the same key (e.g. dragging one region, or typing
   * in one cue) collapse into a single undo entry instead of one per keystroke.
   */
  mergeKey?: string;
  /** Skip the history stack entirely — used when loading a project. */
  replace?: boolean;
}

export const emptyProject: Project = {
  videoPath: "",
  cues: [],
  speakers: [],
  dictionary: [],
};

export function useProjectHistory(initial: Project = emptyProject) {
  const [state, setState] = useState<HistoryState>({
    past: [],
    present: initial,
    future: [],
  });

  const lastMerge = useRef<{ key: string; at: number } | null>(null);
  // Tracks the project as last written to disk, to drive the "unsaved" marker.
  const savedSnapshot = useRef<Project>(initial);

  const update = useCallback(
    (updater: (current: Project) => Project, options: UpdateOptions = {}) => {
      setState((current) => {
        const next = updater(current.present);
        if (next === current.present) return current;

        if (options.replace) {
          lastMerge.current = null;
          return { past: [], present: next, future: [] };
        }

        const now = Date.now();
        const merging =
          options.mergeKey !== undefined &&
          lastMerge.current !== null &&
          lastMerge.current.key === options.mergeKey &&
          now - lastMerge.current.at < MERGE_WINDOW_MS;

        lastMerge.current = options.mergeKey
          ? { key: options.mergeKey, at: now }
          : null;

        if (merging) {
          // Overwrite the present without growing the undo stack.
          return { ...current, present: next, future: [] };
        }

        const past = [...current.past, current.present].slice(-LIMIT);
        return { past, present: next, future: [] };
      });
    },
    [],
  );

  const undo = useCallback(() => {
    lastMerge.current = null;
    setState((current) => {
      if (current.past.length === 0) return current;
      const previous = current.past[current.past.length - 1];
      return {
        past: current.past.slice(0, -1),
        present: previous,
        future: [current.present, ...current.future].slice(0, LIMIT),
      };
    });
  }, []);

  const redo = useCallback(() => {
    lastMerge.current = null;
    setState((current) => {
      if (current.future.length === 0) return current;
      const [next, ...rest] = current.future;
      return {
        past: [...current.past, current.present].slice(-LIMIT),
        present: next,
        future: rest,
      };
    });
  }, []);

  const load = useCallback((project: Project) => {
    lastMerge.current = null;
    savedSnapshot.current = project;
    setState({ past: [], present: project, future: [] });
  }, []);

  const markSaved = useCallback((project: Project) => {
    savedSnapshot.current = project;
    // Force a re-render so `dirty` recomputes.
    setState((current) => ({ ...current }));
  }, []);

  const dirty = state.present !== savedSnapshot.current;

  return useMemo(
    () => ({
      project: state.present,
      update,
      undo,
      redo,
      load,
      markSaved,
      dirty,
      canUndo: state.past.length > 0,
      canRedo: state.future.length > 0,
    }),
    [state, update, undo, redo, load, markSaved, dirty],
  );
}
