import { useCallback, useMemo, useRef, useState } from "react";
import type { Cue } from "../types";

export type SelectMode = "replace" | "toggle" | "range";

/** Derive the click mode from a mouse event, the way every list UI does it. */
export function selectModeOf(event: {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): SelectMode {
  if (event.shiftKey) return "range";
  if (event.ctrlKey || event.metaKey) return "toggle";
  return "replace";
}

export interface CueSelection {
  selectedIds: Set<string>;
  /**
   * The cue single-cue commands act on — the last one touched. Everything that
   * needs exactly one cue (split, jump, the continue-feature) reads this.
   */
  primaryId: string | null;
  select: (id: string, mode?: SelectMode) => void;
  selectOnly: (id: string | null) => void;
  selectAll: () => void;
  clear: () => void;
  isSelected: (id: string) => boolean;
}

/**
 * Multi-selection over the cue list. Range selection walks the cue order the
 * caller passes in, so it always matches what the list shows.
 */
export function useCueSelection(cues: Cue[]): CueSelection {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const anchorId = useRef<string | null>(null);

  // Cues disappear on delete, undo and load; a selection pointing at ghosts
  // would keep commands enabled that have nothing to act on.
  const live = useMemo(() => new Set(cues.map((c) => c.id)), [cues]);
  const pruned = useMemo(() => {
    if (selectedIds.size === 0) return selectedIds;
    const next = new Set<string>();
    for (const id of selectedIds) if (live.has(id)) next.add(id);
    return next.size === selectedIds.size ? selectedIds : next;
  }, [selectedIds, live]);
  const primary = primaryId && live.has(primaryId) ? primaryId : null;

  const cuesRef = useRef(cues);
  cuesRef.current = cues;

  const selectOnly = useCallback((id: string | null) => {
    anchorId.current = id;
    setPrimaryId(id);
    setSelectedIds(id ? new Set([id]) : new Set());
  }, []);

  const select = useCallback(
    (id: string, mode: SelectMode = "replace") => {
      if (mode === "replace") return selectOnly(id);

      if (mode === "toggle") {
        setSelectedIds((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        anchorId.current = id;
        setPrimaryId(id);
        return;
      }

      const list = cuesRef.current;
      const from = list.findIndex((c) => c.id === (anchorId.current ?? id));
      const to = list.findIndex((c) => c.id === id);
      if (to === -1) return;
      const [lo, hi] = from === -1 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
      setSelectedIds(new Set(list.slice(lo, hi + 1).map((c) => c.id)));
      setPrimaryId(id);
    },
    [selectOnly],
  );

  const selectAll = useCallback(() => {
    const list = cuesRef.current;
    if (list.length === 0) return;
    anchorId.current = list[0].id;
    setPrimaryId((current) => current ?? list[0].id);
    setSelectedIds(new Set(list.map((c) => c.id)));
  }, []);

  const clear = useCallback(() => {
    anchorId.current = null;
    setPrimaryId(null);
    setSelectedIds(new Set());
  }, []);

  const isSelected = useCallback((id: string) => pruned.has(id), [pruned]);

  return {
    selectedIds: pruned,
    primaryId: primary,
    select,
    selectOnly,
    selectAll,
    clear,
    isSelected,
  };
}
