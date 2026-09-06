import { useState } from "react";
import type { Cue, Settings, Speaker } from "../types";
import { ContinueLineTab } from "./ContinueLineTab";
import { ContinueSceneTab } from "./ContinueSceneTab";

type Tab = "line" | "scene";

interface Props {
  cues: Cue[];
  speakers: Speaker[];
  selectedCueId: string | null;
  settings: Settings;
  apiKeySet: boolean;
  beats: string[];
  onBeatsChange: (beats: string[], mergeKey?: string) => void;
  onAccept: (text: string, speakerId: string | null) => void;
  onAcceptAll: (lines: Array<{ text: string; speakerId: string | null }>) => boolean;
  onConfirm: (question: string) => Promise<boolean>;
  onOpenSettings: () => void;
  /** Registers the generate handler so Ctrl+G can trigger it. */
  registerGenerate: (fn: (() => void) | null) => void;
}

/**
 * Two ways to write forward: one line for one speaker, or a whole exchange
 * steered by the story's beats. Only the visible tab claims Ctrl+G — React runs
 * the outgoing tab's cleanup before the incoming one registers.
 */
export function ContinuePanel({
  cues,
  speakers,
  selectedCueId,
  settings,
  apiKeySet,
  beats,
  onBeatsChange,
  onAccept,
  onAcceptAll,
  onConfirm,
  onOpenSettings,
  registerGenerate,
}: Props) {
  const [tab, setTab] = useState<Tab>("line");

  return (
    <section className="panel continue-panel">
      <header className="panel-header">
        <h2>Continue</h2>
        <div className="panel-tabs">
          <button
            type="button"
            className={tab === "line" ? "tab on" : "tab"}
            onClick={() => setTab("line")}
          >
            Line
          </button>
          <button
            type="button"
            className={tab === "scene" ? "tab on" : "tab"}
            onClick={() => setTab("scene")}
          >
            Scene
          </button>
        </div>
      </header>

      {!apiKeySet ? (
        <div className="panel-body">
          <p className="hint">No OpenRouter API key saved yet.</p>
          <button type="button" onClick={onOpenSettings}>
            Open Settings
          </button>
        </div>
      ) : tab === "line" ? (
        <ContinueLineTab
          cues={cues}
          speakers={speakers}
          selectedCueId={selectedCueId}
          settings={settings}
          onAccept={onAccept}
          registerGenerate={registerGenerate}
        />
      ) : (
        <ContinueSceneTab
          cues={cues}
          speakers={speakers}
          selectedCueId={selectedCueId}
          settings={settings}
          beats={beats}
          onBeatsChange={onBeatsChange}
          onAccept={onAccept}
          onAcceptAll={onAcceptAll}
          onConfirm={onConfirm}
          registerGenerate={registerGenerate}
        />
      )}
    </section>
  );
}
