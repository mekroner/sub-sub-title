/**
 * What is selected on the voiceover timeline: cues and clips together, so a
 * cue can be moved along with the line spoken for it. The primary item is the
 * one last clicked — the side panels show it, and a range selection runs from
 * it.
 */

export interface VoItem {
  kind: "cue" | "clip";
  id: string;
}

export interface VoSelection {
  cues: Set<string>;
  clips: Set<string>;
  primary: VoItem | null;
}

export const EMPTY_SELECTION: VoSelection = { cues: new Set(), clips: new Set(), primary: null };

export interface SelectionChange {
  items: VoItem[];
  /**
   * "replace" makes `items` the selection; "add" adds them; "toggle" flips
   * each one in or out.
   */
  mode: "replace" | "add" | "toggle";
  /** The item to make primary; by default the last of `items` still selected. */
  primary?: VoItem | null;
}

function has(selection: VoSelection, item: VoItem): boolean {
  return (item.kind === "cue" ? selection.cues : selection.clips).has(item.id);
}

export function isSelected(selection: VoSelection, item: VoItem): boolean {
  return has(selection, item);
}

export function selectionSize(selection: VoSelection): number {
  return selection.cues.size + selection.clips.size;
}

export function applySelection(selection: VoSelection, change: SelectionChange): VoSelection {
  const cues = change.mode === "replace" ? new Set<string>() : new Set(selection.cues);
  const clips = change.mode === "replace" ? new Set<string>() : new Set(selection.clips);
  for (const item of change.items) {
    const set = item.kind === "cue" ? cues : clips;
    if (change.mode === "toggle" && set.has(item.id)) set.delete(item.id);
    else set.add(item.id);
  }
  const next: VoSelection = { cues, clips, primary: null };
  const wanted =
    change.primary !== undefined
      ? change.primary
      : [...change.items].reverse().find((item) => has(next, item)) ?? selection.primary;
  next.primary = wanted && has(next, wanted) ? wanted : null;
  return next;
}

/**
 * Drops anything that no longer exists — after an undo, a delete, a load —
 * returning the same object when nothing went.
 */
export function pruneSelection(
  selection: VoSelection,
  cueIds: Set<string>,
  clipIds: Set<string>,
): VoSelection {
  const cues = [...selection.cues].filter((id) => cueIds.has(id));
  const clips = [...selection.clips].filter((id) => clipIds.has(id));
  if (cues.length === selection.cues.size && clips.length === selection.clips.size) return selection;
  const next: VoSelection = { cues: new Set(cues), clips: new Set(clips), primary: null };
  next.primary = selection.primary && has(next, selection.primary) ? selection.primary : null;
  return next;
}
