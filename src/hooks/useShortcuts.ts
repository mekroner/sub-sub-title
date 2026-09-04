import { useEffect, useRef } from "react";
import { matchShortcut } from "./shortcutMatch";

export interface ShortcutActions {
  togglePlay: () => void;
  assignSpeakerIndex: (index: number) => void;
  clearSpeaker: () => void;
  splitAtPlayhead: () => void;
  mergeWithNext: () => void;
  /** edge: which side to move; direction: -1 earlier, +1 later. */
  nudge: (edge: "start" | "end" | "both", direction: number) => void;
  selectPrevious: () => void;
  selectNext: () => void;
  jumpToSelected: () => void;
  newCueAtPlayhead: () => void;
  deleteSelected: () => void;
  generateContinuation: () => void;
  save: () => void;
  saveAs: () => void;
  newProject: () => void;
  openProject: () => void;
  undo: () => void;
  redo: () => void;
  zoom: (direction: number) => void;
  toggleFollow: () => void;
  showHelp: () => void;
}

/** Typing in a field must never trigger an editing shortcut. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

export function useShortcuts(actions: ShortcutActions, enabled: boolean) {
  // Held in a ref so the listener is installed once and never sees stale state.
  const ref = useRef(actions);
  ref.current = actions;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextEntry(e.target)) return;

      const command = matchShortcut(e);
      if (!command) return;

      const a = ref.current;
      switch (command.type) {
        case "togglePlay":
          a.togglePlay();
          break;
        case "assignSpeaker":
          a.assignSpeakerIndex(command.index);
          break;
        case "clearSpeaker":
          a.clearSpeaker();
          break;
        case "split":
          a.splitAtPlayhead();
          break;
        case "merge":
          a.mergeWithNext();
          break;
        case "nudge":
          a.nudge(command.edge, command.direction);
          break;
        case "selectPrevious":
          a.selectPrevious();
          break;
        case "selectNext":
          a.selectNext();
          break;
        case "jumpToSelected":
          a.jumpToSelected();
          break;
        case "newCue":
          a.newCueAtPlayhead();
          break;
        case "deleteSelected":
          a.deleteSelected();
          break;
        case "generate":
          a.generateContinuation();
          break;
        case "save":
          a.save();
          break;
        case "saveAs":
          a.saveAs();
          break;
        case "newProject":
          a.newProject();
          break;
        case "openProject":
          a.openProject();
          break;
        case "undo":
          a.undo();
          break;
        case "redo":
          a.redo();
          break;
        case "zoom":
          a.zoom(command.direction);
          break;
        case "toggleFollow":
          a.toggleFollow();
          break;
        case "showHelp":
          a.showHelp();
          break;
      }

      e.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
