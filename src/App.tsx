import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import { VideoPane } from "./components/VideoPane";
import { WaveformPane } from "./components/WaveformPane";
import { CueList } from "./components/CueList";
import { SpeakerPanel } from "./components/SpeakerPanel";
import { ContinuePanel } from "./components/ContinuePanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { RenderDialog } from "./components/RenderDialog";

import { useProjectHistory } from "./state/useProjectHistory";
import { useShortcuts } from "./hooks/useShortcuts";

import * as api from "./lib/api";
import { errorMessage } from "./lib/api";
import { buildAss } from "./lib/ass";
import { parseSrt, serializeSrt, speakerNameOf, stripSpeakerPrefix } from "./lib/srt";
import { nextPaletteColor } from "./lib/colors";
import { makeId } from "./lib/ids";
import { clamp } from "./lib/time";
import {
  findActiveCueIndex,
  insertCue,
  mergeWithNext,
  newCue,
  nudgeCue,
  setCueTiming,
  slotAfter,
  sortCues,
  splitCueAt,
} from "./lib/cues";
import type {
  Cue,
  MediaInfo,
  Project,
  ProjectPaths,
  Settings,
  Sidecar,
  Speaker,
  ToolStatus,
} from "./types";

const DEFAULT_SETTINGS: Settings = {
  model: "anthropic/claude-sonnet-4.5",
  temperature: 0.9,
  contextLines: 12,
  candidateCount: 3,
  styleNotes: "",
  fontName: "Arial",
  fontSize: 48,
  outline: 2,
  shadow: 0,
  peaksResolution: 80,
};

const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "webm", "mkv"];

export default function App() {
  const { project, update, undo, redo, load, markSaved, dirty, canUndo, canRedo } =
    useProjectHistory();

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [apiKeySet, setApiKeySet] = useState(false);
  const [tools, setTools] = useState<ToolStatus | null>(null);

  const [paths, setPaths] = useState<ProjectPaths | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [peaksBusy, setPeaksBusy] = useState(false);

  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(50);
  const [follow, setFollow] = useState(true);

  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showRender, setShowRender] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: "info" | "error" } | null>(
    null,
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  // The waveform needs the element as state (to re-init wavesurfer), but the
  // callback itself must be stable: an inline ref is detached and reattached on
  // every render, which would churn the wavesurfer instance.
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    setVideoEl(el);
  }, []);
  const generateRef = useRef<(() => void) | null>(null);

  const cues = project.cues;
  const speakers = project.speakers;

  const notify = useCallback((text: string, kind: "info" | "error" = "info") => {
    setToast({ text, kind });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === "error" ? 9000 : 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // --- Boot ---------------------------------------------------------------
  useEffect(() => {
    api.loadSettings().then(setSettings).catch(() => undefined);
    api.hasApiKey().then(setApiKeySet).catch(() => undefined);
    api
      .checkTools()
      .then((status) => {
        setTools(status);
        if (!status.ffmpeg || !status.ffprobe) {
          notify(
            "ffmpeg was not found on PATH. Waveform and burn-in are unavailable.",
            "error",
          );
        }
      })
      .catch(() => undefined);
  }, [notify]);

  const activeIndex = useMemo(
    () => findActiveCueIndex(cues, currentTime),
    [cues, currentTime],
  );
  const activeCue = activeIndex >= 0 ? cues[activeIndex] : null;
  const selectedCue = useMemo(
    () => cues.find((c) => c.id === selectedCueId) ?? null,
    [cues, selectedCueId],
  );
  const frameStep = media && media.fps > 0 ? 1 / media.fps : 0.04;
  const duration = media?.duration ?? 0;

  // --- Seeking ------------------------------------------------------------
  const seek = useCallback(
    (time: number) => {
      const video = videoRef.current;
      const target = clamp(time, 0, duration || Number.MAX_SAFE_INTEGER);
      if (video) video.currentTime = target;
      setCurrentTime(target);
    },
    [duration],
  );

  // --- Opening a video ----------------------------------------------------
  const openVideoAt = useCallback(
    async (path: string) => {
      try {
        const info = await api.probeMedia(path);
        const derived = await api.derivePaths(path);

        setMedia(info);
        setPaths(derived);
        setVideoUrl(convertFileSrc(path));
        setPeaks(null);
        setCurrentTime(0);
        setSelectedCueId(null);

        // Prefer the sidecar (it has speakers); fall back to a sibling .srt.
        let loaded: Project = { videoPath: path, cues: [], speakers: [] };
        if (await api.fileExists(derived.sidecar)) {
          const raw = await api.readTextFile(derived.sidecar);
          const parsed = JSON.parse(raw) as Sidecar;
          loaded = {
            videoPath: path,
            cues: sortCues(parsed.cues ?? []),
            speakers: parsed.speakers ?? [],
          };
          notify(`Loaded ${loaded.cues.length} cues from the project sidecar.`);
        } else if (await api.fileExists(derived.srt)) {
          const raw = await api.readTextFile(derived.srt);
          const { cues: parsed, warnings } = parseSrt(raw);
          loaded = { videoPath: path, cues: parsed, speakers: [] };
          notify(
            `Imported ${parsed.length} cues from ${derived.stem}.srt` +
              (warnings.length ? ` (${warnings.length} warnings).` : "."),
          );
        } else {
          notify("Video opened. No matching .srt or sidecar found.");
        }

        load(loaded);
        if (loaded.cues.length > 0) setSelectedCueId(loaded.cues[0].id);

        if (!info.hasAudio) {
          notify("This file has no audio track, so there is no waveform.", "error");
        }
      } catch (e) {
        notify(errorMessage(e), "error");
      }
    },
    [load, notify],
  );

  // Opened via "Open with" in Explorer, or a path on the command line.
  const openedStartupFile = useRef(false);
  useEffect(() => {
    if (openedStartupFile.current) return;
    openedStartupFile.current = true;
    api
      .startupFile()
      .then((path) => {
        if (path) void openVideoAt(path);
      })
      .catch(() => undefined);
  }, [openVideoAt]);

  const chooseVideo = useCallback(async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
    });
    if (typeof picked === "string") await openVideoAt(picked);
  }, [openVideoAt]);

  // --- Waveform extraction -------------------------------------------------
  useEffect(() => {
    const path = project.videoPath;
    if (!path || !media?.hasAudio) return;

    let cancelled = false;
    setPeaksBusy(true);
    api
      .computePeaks(path, settings.peaksResolution)
      .then((result) => {
        if (cancelled) return;
        setPeaks(result.peaks);
      })
      .catch((e) => {
        if (!cancelled) notify(errorMessage(e), "error");
      })
      .finally(() => {
        if (!cancelled) setPeaksBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [project.videoPath, media, settings.peaksResolution, notify]);

  // --- Cue mutations ------------------------------------------------------
  const setCues = useCallback(
    (fn: (cues: Cue[]) => Cue[], mergeKey?: string) => {
      update((current) => {
        const next = fn(current.cues);
        return next === current.cues ? current : { ...current, cues: next };
      }, mergeKey ? { mergeKey } : undefined);
    },
    [update],
  );

  const editText = useCallback(
    (id: string, text: string) =>
      setCues(
        (list) => list.map((c) => (c.id === id ? { ...c, text } : c)),
        `text:${id}`,
      ),
    [setCues],
  );

  const editTiming = useCallback(
    (id: string, start: number, end: number) =>
      setCues((list) => sortCues(setCueTiming(list, id, start, end, duration))),
    [setCues, duration],
  );

  const retimeFromWaveform = useCallback(
    (id: string, start: number, end: number) =>
      setCues(
        (list) => sortCues(setCueTiming(list, id, start, end, duration)),
        `drag:${id}`,
      ),
    [setCues, duration],
  );

  const assignSpeaker = useCallback(
    (cueId: string, speakerId: string | null) =>
      setCues((list) => list.map((c) => (c.id === cueId ? { ...c, speakerId } : c))),
    [setCues],
  );

  const createCue = useCallback(
    (start: number, end: number) => {
      const cue = newCue(start, end, selectedCue?.speakerId ?? null);
      setCues((list) => insertCue(list, cue));
      setSelectedCueId(cue.id);
    },
    [setCues, selectedCue],
  );

  // --- Speakers -----------------------------------------------------------
  const addSpeaker = useCallback(() => {
    const speaker: Speaker = {
      id: makeId(),
      name: `Speaker ${project.speakers.length + 1}`,
      color: nextPaletteColor(project.speakers.map((s) => s.color)),
    };
    update((current) => ({ ...current, speakers: [...current.speakers, speaker] }));
  }, [update, project.speakers.length]);

  const updateSpeaker = useCallback(
    (id: string, patch: Partial<Speaker>) =>
      update(
        (current) => ({
          ...current,
          speakers: current.speakers.map((s) => (s.id === id ? { ...s, ...patch } : s)),
        }),
        { mergeKey: `speaker:${id}` },
      ),
    [update],
  );

  const removeSpeaker = useCallback(
    (id: string) =>
      update((current) => ({
        ...current,
        speakers: current.speakers.filter((s) => s.id !== id),
        // Cues keep their text but lose the dangling reference.
        cues: current.cues.map((c) => (c.speakerId === id ? { ...c, speakerId: null } : c)),
      })),
    [update],
  );

  /**
   * Turn detected `NAME:` prefixes into real speakers and strip the prefix from
   * the cue text, so a transcript that already marks speakers is tagged in one go.
   */
  const applyDetectedSpeakers = useCallback(
    (names: string[]) => {
      update((current) => {
        const speakers = [...current.speakers];
        const byName = new Map(speakers.map((s) => [s.name.toUpperCase(), s]));

        for (const name of names) {
          if (byName.has(name.toUpperCase())) continue;
          const speaker: Speaker = {
            id: makeId(),
            name,
            color: nextPaletteColor(speakers.map((s) => s.color)),
          };
          speakers.push(speaker);
          byName.set(name.toUpperCase(), speaker);
        }

        const cues = current.cues.map((cue) => {
          const detected = speakerNameOf(cue.text);
          if (!detected) return cue;
          const speaker = byName.get(detected.toUpperCase());
          if (!speaker) return cue;
          return { ...cue, speakerId: speaker.id, text: stripSpeakerPrefix(cue.text) };
        });

        return { ...current, speakers, cues };
      });
      notify(`Tagged cues from ${names.length} detected speaker names.`);
    },
    [update, notify],
  );

  // --- File actions -------------------------------------------------------
  const saveSidecar = useCallback(async () => {
    if (!paths) return notify("Open a video first.", "error");
    try {
      const sidecar: Sidecar = {
        version: 1,
        savedAt: new Date().toISOString(),
        ...project,
      };
      await api.writeTextFile(paths.sidecar, JSON.stringify(sidecar, null, 2));
      markSaved(project);
      notify(`Saved ${paths.stem}.captions.json`);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }, [paths, project, markSaved, notify]);

  const importSrtFrom = useCallback(
    async (path: string) => {
      try {
        const raw = await api.readTextFile(path);
        const { cues: parsed, warnings } = parseSrt(raw);
        if (parsed.length === 0) {
          return notify("No cues could be read from that file.", "error");
        }
        update((current) => ({ ...current, cues: parsed }));
        setSelectedCueId(parsed[0].id);
        notify(
          `Imported ${parsed.length} cues` +
            (warnings.length ? `; ${warnings.length} lines needed repair.` : "."),
        );
      } catch (e) {
        notify(errorMessage(e), "error");
      }
    },
    [update, notify],
  );

  const importSrt = useCallback(async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "SubRip subtitles", extensions: ["srt"] }],
    });
    if (typeof picked === "string") await importSrtFrom(picked);
  }, [importSrtFrom]);

  const exportSrt = useCallback(async () => {
    if (cues.length === 0) return notify("Nothing to export.", "error");
    const target = await saveDialog({
      defaultPath: paths?.srt,
      filters: [{ name: "SubRip subtitles", extensions: ["srt"] }],
    });
    if (!target) return;
    try {
      await api.writeTextFile(target, serializeSrt(cues));
      notify(`Exported ${cues.length} cues to .srt`);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }, [cues, paths, notify]);

  const assText = useMemo(
    () =>
      buildAss(cues, speakers, {
        settings,
        width: media?.width ?? 0,
        height: media?.height ?? 0,
      }),
    [cues, speakers, settings, media],
  );

  const exportAss = useCallback(async () => {
    if (cues.length === 0) return notify("Nothing to export.", "error");
    const target = await saveDialog({
      defaultPath: paths?.ass,
      filters: [{ name: "Advanced SubStation Alpha", extensions: ["ass"] }],
    });
    if (!target) return;
    try {
      await api.writeTextFile(target, assText);
      notify(`Exported styled .ass with ${speakers.length} speaker styles.`);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }, [cues, speakers, assText, paths, notify]);

  // --- Continue-feature ---------------------------------------------------
  const acceptGenerated = useCallback(
    (text: string, speakerId: string | null) => {
      const { start, end } = slotAfter(cues, selectedCueId, duration);
      const cue: Cue = { id: makeId(), start, end, text, speakerId };
      setCues((list) => insertCue(list, cue));
      setSelectedCueId(cue.id);
      notify("Added the line. Set its timing on the waveform.");
    },
    [cues, selectedCueId, duration, setCues, notify],
  );

  const registerGenerate = useCallback((fn: (() => void) | null) => {
    generateRef.current = fn;
  }, []);

  // --- Shortcuts ----------------------------------------------------------
  const modalOpen = showSettings || showHelp || showRender;

  useShortcuts(
    {
      togglePlay: () => {
        const video = videoRef.current;
        if (!video) return;
        if (video.paused) void video.play();
        else video.pause();
      },
      assignSpeakerIndex: (index) => {
        const speaker = speakers[index];
        if (!speaker || !selectedCueId) return;
        assignSpeaker(selectedCueId, speaker.id);
      },
      clearSpeaker: () => {
        if (selectedCueId) assignSpeaker(selectedCueId, null);
      },
      splitAtPlayhead: () => {
        if (!selectedCueId) return;
        const result = splitCueAt(cues, selectedCueId, currentTime);
        if (!result.newCueId) {
          return notify("Move the playhead inside the selected cue to split it.", "error");
        }
        setCues(() => result.cues);
        setSelectedCueId(result.newCueId);
      },
      mergeWithNext: () => {
        if (!selectedCueId) return;
        setCues((list) => mergeWithNext(list, selectedCueId));
      },
      nudge: (edge, direction) => {
        if (!selectedCueId) return;
        setCues(
          (list) => nudgeCue(list, selectedCueId, edge, direction * frameStep, duration),
          `nudge:${selectedCueId}:${edge}`,
        );
      },
      selectPrevious: () => {
        const index = cues.findIndex((c) => c.id === selectedCueId);
        const target = index > 0 ? cues[index - 1] : cues[0];
        if (target) setSelectedCueId(target.id);
      },
      selectNext: () => {
        const index = cues.findIndex((c) => c.id === selectedCueId);
        const target = index >= 0 ? cues[index + 1] : cues[0];
        if (target) setSelectedCueId(target.id);
      },
      jumpToSelected: () => {
        if (selectedCue) seek(selectedCue.start);
      },
      newCueAtPlayhead: () => {
        const end = Math.min(currentTime + 2, duration || currentTime + 2);
        createCue(currentTime, end);
      },
      deleteSelected: () => {
        if (!selectedCueId) return;
        const index = cues.findIndex((c) => c.id === selectedCueId);
        setCues((list) => list.filter((c) => c.id !== selectedCueId));
        const nextSelection = cues[index + 1] ?? cues[index - 1] ?? null;
        setSelectedCueId(nextSelection?.id ?? null);
      },
      generateContinuation: () => {
        if (generateRef.current) generateRef.current();
        else notify("Add an OpenRouter API key in Settings first.", "error");
      },
      save: () => void saveSidecar(),
      undo,
      redo,
      zoom: (direction) => setZoom((z) => clamp(Math.round(z * (direction > 0 ? 1.4 : 1 / 1.4)), 5, 600)),
      toggleFollow: () => setFollow((f) => !f),
      showHelp: () => setShowHelp(true),
    },
    !modalOpen,
  );

  // --- Render -------------------------------------------------------------
  const activeSpeaker =
    speakers.find((s) => s.id === activeCue?.speakerId) ?? null;

  return (
    <div className="app">
      <header className="toolbar">
        <div className="toolbar-group">
          <button type="button" className="primary" onClick={chooseVideo}>
            Open video…
          </button>
          <button type="button" onClick={importSrt} disabled={!paths}>
            Import .srt
          </button>
          <button type="button" onClick={saveSidecar} disabled={!paths}>
            Save{dirty ? " •" : ""}
          </button>
        </div>

        <div className="toolbar-group">
          <button type="button" onClick={exportSrt} disabled={cues.length === 0}>
            Export .srt
          </button>
          <button type="button" onClick={exportAss} disabled={cues.length === 0}>
            Export .ass
          </button>
          <button
            type="button"
            onClick={() => setShowRender(true)}
            disabled={cues.length === 0 || !tools?.ffmpeg}
            title={tools?.ffmpeg ? "Burn subtitles into a new video" : "ffmpeg not found"}
          >
            Burn in…
          </button>
        </div>

        <div className="toolbar-group">
          <button type="button" onClick={undo} disabled={!canUndo} title="Ctrl+Z">
            ↶
          </button>
          <button type="button" onClick={redo} disabled={!canRedo} title="Ctrl+Y">
            ↷
          </button>
        </div>

        <div className="toolbar-spacer">
          <span className="file-label">
            {paths ? `${paths.stem} — ${cues.length} cues` : "No project"}
            {peaksBusy && " · extracting waveform…"}
          </span>
        </div>

        <div className="toolbar-group">
          <label className="zoom-control" title="Waveform zoom">
            <span>Zoom</span>
            <input
              type="range"
              min={5}
              max={400}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
          </label>
          <button
            type="button"
            className={follow ? "toggle on" : "toggle"}
            onClick={() => setFollow((f) => !f)}
            title="Follow the playhead (F)"
          >
            Follow
          </button>
          <button type="button" onClick={() => setShowHelp(true)} title="Shortcuts (?)">
            ?
          </button>
          <button type="button" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
      </header>

      <main className="layout">
        <div className="stage-column">
          <VideoPane
            ref={attachVideo}
            src={videoUrl}
            activeCue={activeCue}
            speaker={activeSpeaker}
            settings={settings}
            videoWidth={media?.width ?? 0}
            videoHeight={media?.height ?? 0}
            onTimeUpdate={setCurrentTime}
            onDurationChange={(d) =>
              setMedia((m) => (m && !m.duration ? { ...m, duration: d } : m))
            }
            onPlayingChange={setPlaying}
            onError={(message) => notify(message, "error")}
          />

          <WaveformPane
            videoEl={videoEl}
            peaks={peaks}
            duration={duration}
            cues={cues}
            speakers={speakers}
            selectedCueId={selectedCueId}
            zoom={zoom}
            onSelectCue={setSelectedCueId}
            onRetimeCue={(id, start, end) => retimeFromWaveform(id, start, end)}
            onCreateCue={createCue}
            // Clicking a region must move the video, not just the app's clock.
            onSeek={seek}
          />
        </div>

        <aside className="side-column">
          <SpeakerPanel
            speakers={speakers}
            cues={cues}
            selectedCueId={selectedCueId}
            onAdd={addSpeaker}
            onUpdate={updateSpeaker}
            onRemove={removeSpeaker}
            onAssignToSelected={(speakerId) =>
              selectedCueId && assignSpeaker(selectedCueId, speakerId)
            }
            onApplyDetected={applyDetectedSpeakers}
          />

          <ContinuePanel
            cues={cues}
            speakers={speakers}
            selectedCueId={selectedCueId}
            settings={settings}
            apiKeySet={apiKeySet}
            onAccept={acceptGenerated}
            onOpenSettings={() => setShowSettings(true)}
            registerGenerate={registerGenerate}
          />
        </aside>

        <section className="list-row">
          <CueList
            cues={cues}
            speakers={speakers}
            selectedCueId={selectedCueId}
            activeCueId={activeCue?.id ?? null}
            follow={follow && playing}
            onSelect={setSelectedCueId}
            onSeek={seek}
            onEditText={editText}
            onEditTiming={editTiming}
            onAssignSpeaker={assignSpeaker}
          />
        </section>
      </main>

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}

      {showSettings && (
        <SettingsDialog
          settings={settings}
          apiKeySet={apiKeySet}
          onSave={(next) => {
            setSettings(next);
            api.saveSettings(next).catch((e) => notify(errorMessage(e), "error"));
          }}
          onApiKeyChange={setApiKeySet}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showHelp && <ShortcutsDialog onClose={() => setShowHelp(false)} />}

      {showRender && paths && (
        <RenderDialog
          videoPath={project.videoPath}
          defaultOutput={paths.burned}
          assPath={paths.ass}
          assText={assText}
          duration={duration}
          onClose={() => setShowRender(false)}
        />
      )}
    </div>
  );
}
