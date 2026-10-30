import { useEffect, useLayoutEffect, useRef } from "react";
import type { GhostBinding } from "../hooks/useGhostCompletion";

interface Props {
  cueId: string;
  value: string;
  className: string;
  /** The grey text to show after the value; empty for none. */
  ghost: string;
  pending: boolean;
  binding: GhostBinding;
  onChange: (text: string) => void;
  onFocus: () => void;
}

/**
 * A cue's text field with autocomplete shown in grey after the caret.
 *
 * A `<textarea>` cannot colour part of its own text, so a mirror sits behind a
 * transparent textarea with the same box, font and wrapping: the typed text in
 * it is invisible, and the ghost follows it in grey exactly where the textarea
 * would put the next character.
 */
export function GhostTextarea({
  cueId,
  value,
  className,
  ghost,
  pending,
  binding,
  onChange,
  onFocus,
}: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  /** Set when accepting, so the caret lands after the accepted text. */
  const caretToEnd = useRef(false);
  /** Whether the ghost made the field taller, so the height is ours to reset. */
  const grown = useRef(false);

  const report = () => {
    const el = ref.current;
    if (!el || document.activeElement !== el) return;
    const end = el.value.length;
    binding.track(cueId, el.value, el.selectionStart === end && el.selectionEnd === end);
  };

  // Covers typing, accepting, and changes from outside such as undo.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && caretToEnd.current) {
      caretToEnd.current = false;
      el.setSelectionRange(el.value.length, el.value.length);
    }
    report();
  }, [value]);

  // The caret leaving the end hides the ghost. React's onSelect misses some
  // caret moves, so listen for the native event as well; it may be dispatched
  // at the textarea or at the document depending on the engine.
  const reportRef = useRef(report);
  reportRef.current = report;
  useEffect(() => {
    const el = ref.current;
    const onSelectionChange = () => reportRef.current();
    el?.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      el?.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, []);

  // A ghost that wraps onto another line must not be clipped.
  useLayoutEffect(() => {
    const el = ref.current;
    const mirror = mirrorRef.current;
    if (!el) return;
    if (ghost && mirror) {
      const borders = el.offsetHeight - el.clientHeight;
      if (mirror.scrollHeight > el.clientHeight) {
        el.style.height = `${mirror.scrollHeight + borders}px`;
        grown.current = true;
      }
      mirror.scrollTop = el.scrollTop;
    } else if (grown.current) {
      el.style.height = "";
      grown.current = false;
    }
  }, [ghost, value]);

  const acceptPart = (part: "all" | "word", el: HTMLTextAreaElement) => {
    const next = binding.accept(cueId, el.value, part);
    if (next === null) return false;
    caretToEnd.current = true;
    onChange(next);
    return true;
  };

  return (
    <div className={`ghost-field${ghost ? " has-ghost" : ""}${pending ? " pending" : ""}`}>
      {ghost && (
        <div ref={mirrorRef} className={`${className} ghost-mirror`} aria-hidden>
          <span className="ghost-typed">{value}</span>
          <span className="ghost-text">{ghost}</span>
        </div>
      )}
      <textarea
        ref={ref}
        className={className}
        value={value}
        rows={Math.min(4, value.split("\n").length || 1)}
        spellCheck={false}
        title={ghost ? "Tab to accept · Ctrl+→ for one word · Esc to dismiss" : undefined}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => {
          onFocus();
          report();
        }}
        onBlur={() => binding.blur(cueId)}
        onSelect={report}
        onKeyUp={report}
        onMouseUp={report}
        onScroll={(e) => {
          if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
        onKeyDown={(e) => {
          // Let the textarea own its keys; the global shortcuts must not
          // steal Space, digits, arrows or Enter while typing.
          e.stopPropagation();
          const ctrl = e.ctrlKey || e.metaKey;

          if (ctrl && e.shiftKey && (e.code === "Space" || e.key === " ")) {
            e.preventDefault();
            binding.toggle();
            return;
          }
          if (!ghost) return;

          if (e.key === "Tab" && !ctrl && !e.shiftKey && !e.altKey) {
            if (acceptPart("all", e.currentTarget)) e.preventDefault();
          } else if (e.key === "ArrowRight" && ctrl && !e.shiftKey && !e.altKey) {
            if (acceptPart("word", e.currentTarget)) e.preventDefault();
          } else if (e.key === "Escape") {
            e.preventDefault();
            binding.dismiss();
          }
        }}
      />
    </div>
  );
}
