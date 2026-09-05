import { useEffect, useRef } from "react";

interface Props {
  query: string;
  replacement: string;
  matchCase: boolean;
  matchCount: number;
  /** 1-based position of the cue currently selected among the matches, or 0. */
  position: number;
  onQueryChange: (value: string) => void;
  onReplacementChange: (value: string) => void;
  onMatchCaseChange: (value: boolean) => void;
  onStep: (direction: 1 | -1) => void;
  onReplaceOne: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}

/**
 * Find and replace across cue text. A `<textarea>` cannot highlight a match
 * inside itself, so the cue list marks whole rows instead and stepping through
 * matches selects and seeks to them.
 */
export function FindBar({
  query,
  replacement,
  matchCase,
  matchCount,
  position,
  onQueryChange,
  onReplacementChange,
  onMatchCaseChange,
  onStep,
  onReplaceOne,
  onReplaceAll,
  onClose,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div
      className="find-bar"
      // The fields are text entry, so the global shortcuts stay out of the way.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
        if (e.key === "Enter") {
          e.preventDefault();
          onStep(e.shiftKey ? -1 : 1);
        }
      }}
    >
      <input
        ref={inputRef}
        className="find-input"
        placeholder="Find in cues"
        value={query}
        spellCheck={false}
        onChange={(e) => onQueryChange(e.target.value)}
      />

      <span className="find-count">
        {query === "" ? "" : matchCount === 0 ? "no matches" : `${position} / ${matchCount}`}
      </span>

      <button type="button" title="Previous match (Shift+Enter)" onClick={() => onStep(-1)}>
        ↑
      </button>
      <button type="button" title="Next match (Enter)" onClick={() => onStep(1)}>
        ↓
      </button>

      <label className="find-toggle" title="Match case">
        <input
          type="checkbox"
          checked={matchCase}
          onChange={(e) => onMatchCaseChange(e.target.checked)}
        />
        <span>Aa</span>
      </label>

      <input
        className="find-input"
        placeholder="Replace with"
        value={replacement}
        spellCheck={false}
        onChange={(e) => onReplacementChange(e.target.value)}
      />
      <button type="button" disabled={matchCount === 0} onClick={onReplaceOne}>
        Replace
      </button>
      <button type="button" disabled={matchCount === 0} onClick={onReplaceAll}>
        All
      </button>

      <button type="button" className="icon-button" title="Close (Esc)" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}
