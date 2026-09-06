import { useEffect, useRef } from "react";
import { isTextEntry } from "./useShortcuts";

/**
 * Ctrl+V outside any text field, handed to the app as plain text.
 *
 * This listens for the paste event rather than claiming Ctrl+V in
 * `shortcutMatch`, for two reasons: the event carries the clipboard with it, so
 * nothing has to ask for clipboard permission, and pasting inside a cue's
 * textarea keeps going to the webview, which is what the user wants there.
 */
export function usePasteText(onText: (text: string) => void, enabled: boolean) {
  // Held in a ref so the listener is installed once and never sees stale state.
  const ref = useRef(onText);
  ref.current = onText;

  useEffect(() => {
    if (!enabled) return;

    const onPaste = (e: ClipboardEvent) => {
      if (isTextEntry(e.target)) return;

      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text.trim() === "") return;

      e.preventDefault();
      ref.current(text);
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [enabled]);
}
