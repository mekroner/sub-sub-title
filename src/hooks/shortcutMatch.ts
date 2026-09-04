/**
 * Key matching for the editor shortcuts, kept pure so it can be tested without
 * a DOM.
 *
 * Matching prefers `KeyboardEvent.code` (physical key position) so the bindings
 * survive a non-US layout — on a Norwegian keyboard `[` and `]` need AltGr, but
 * the physical keys are still BracketLeft/BracketRight. Some sources
 * (automation, on-screen keyboards, a few IMEs) leave `code` empty, so `key` is
 * used as a fallback.
 */

export type ShortcutCommand =
  | { type: "togglePlay" }
  | { type: "assignSpeaker"; index: number }
  | { type: "clearSpeaker" }
  | { type: "split" }
  | { type: "merge" }
  | { type: "nudge"; edge: "start" | "end" | "both"; direction: number }
  | { type: "selectPrevious" }
  | { type: "selectNext" }
  | { type: "jumpToSelected" }
  | { type: "newCue" }
  | { type: "deleteSelected" }
  | { type: "generate" }
  | { type: "save" }
  | { type: "saveAs" }
  | { type: "newProject" }
  | { type: "openProject" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "zoom"; direction: number }
  | { type: "toggleFollow" }
  | { type: "showHelp" };

export interface KeyLike {
  code?: string;
  key?: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/** Reconstruct a `code` from `key` for events that omit it. */
function effectiveCode(event: KeyLike): string {
  if (event.code) return event.code;

  const key = event.key;
  if (!key) return "";
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;

  const named: Record<string, string> = {
    " ": "Space",
    Spacebar: "Space",
    Enter: "Enter",
    Delete: "Delete",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    "[": "BracketLeft",
    "]": "BracketRight",
    ",": "Comma",
    ".": "Period",
    "-": "Minus",
    "=": "Equal",
    "+": "Equal",
    "/": "Slash",
    "?": "Slash",
  };
  return named[key] ?? "";
}

export function matchShortcut(event: KeyLike): ShortcutCommand | null {
  const code = effectiveCode(event);
  const ctrl = Boolean(event.ctrlKey || event.metaKey);
  const shift = Boolean(event.shiftKey);
  const alt = Boolean(event.altKey);

  if (ctrl) {
    switch (code) {
      case "KeyG":
        return { type: "generate" };
      case "KeyS":
        return shift ? { type: "saveAs" } : { type: "save" };
      case "KeyN":
        return { type: "newProject" };
      case "KeyO":
        return { type: "openProject" };
      case "KeyZ":
        return shift ? { type: "redo" } : { type: "undo" };
      case "KeyY":
        return { type: "redo" };
      default:
        // Every other Ctrl chord belongs to the webview.
        return null;
    }
  }

  // Nudging, matched on physical position.
  const earlier = code === "BracketLeft" || code === "Comma";
  const later = code === "BracketRight" || code === "Period";
  if (earlier || later) {
    const edge = alt ? "both" : shift ? "end" : "start";
    return { type: "nudge", edge, direction: earlier ? -1 : 1 };
  }

  const digit = /^Digit([0-9])$/.exec(code);
  if (digit && !shift && !alt) {
    const n = Number(digit[1]);
    return n === 0 ? { type: "clearSpeaker" } : { type: "assignSpeaker", index: n - 1 };
  }

  // `?` is Shift+Slash on US layouts, but arrives as a bare "?" key elsewhere.
  if (code === "Slash") {
    return shift || event.key === "?" ? { type: "showHelp" } : null;
  }

  switch (code) {
    case "Space":
      return { type: "togglePlay" };
    case "KeyS":
      return { type: "split" };
    case "KeyM":
      return { type: "merge" };
    case "KeyN":
      return { type: "newCue" };
    case "KeyF":
      return { type: "toggleFollow" };
    case "ArrowUp":
      return { type: "selectPrevious" };
    case "ArrowDown":
      return { type: "selectNext" };
    case "Enter":
    case "NumpadEnter":
      return { type: "jumpToSelected" };
    case "Delete":
      return { type: "deleteSelected" };
    case "Equal":
    case "NumpadAdd":
      return { type: "zoom", direction: 1 };
    case "Minus":
    case "NumpadSubtract":
      return { type: "zoom", direction: -1 };
    default:
      return null;
  }
}
