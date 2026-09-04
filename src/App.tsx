import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import { TransportBar } from "./components/TransportBar";
import { VideoPane } from "./components/VideoPane";
import { MAX_ZOOM, MIN_ZOOM, WaveformPane } from "./components/WaveformPane";
import { CueList } from "./components/CueList";
import { SpeakerPanel } from "./components/SpeakerPanel";
import { ContinuePanel } from "./components/ContinuePanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { RenderDialog } from "./components/RenderDialog";
import { MenuBar } from "./components/MenuBar";
import type { Menu } from "./components/MenuBar";

import { emptyProject, useProjectHistory } from "./state/useProjectHistory";
import { useShortcuts } from "./hooks/useShortcuts";

import * as api from "./lib/api";
import { errorMessage } from "./lib/api";
import { buildAss } from "./lib/ass";
import { parseSrt, serializeSrt, speakerNameOf, stripSpeakerPrefix } from "./lib/srt";
import { nextPaletteColor } from "./lib/colors";
import { classifyDrop, VIDEO_EXTENSIONS } from "./lib/dropPaths";
import {
  PROJECT_EXTENSION,
  parseProjectFile,
  projectName,
  serializeProjectFile,
} from "./lib/projectFile";
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
  AppState,
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

const STORAGE_PREFIX = "sub-sub-title:";

/** localStorage can throw outright (blocked site data), so never let it escape. */
function readStored(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: number): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, String(value));
  } catch {
    // A lost preference is not worth interrupting an edit session.
  }
}

export default function App() {
  const { project, update, undo, redo, load, markSaved, dirty, canUndo, canRedo } =
    useProjectHistory();

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [apiKeySet, setApiKeySet] = useState(false);
  const [tools, setTools] = useState<ToolStatus | null>(null);

  // The `.sstproj` this project was loaded from / last saved to; null until the
  // first Save As.
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [appState, setAppState] = useState<AppState>({
    lastProject: null,
    recentProjects: [],
  });

  const [paths, setPaths] = useState<ProjectPaths | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [peaksBusy, setPeaksBusy] = useState(false);

  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(50);
  const [dropActive, setDropActive] = useState(false);
  // Transport preferences are per-machine UI state, so they live in
  // localStorage rather than the project or the app config file.
  const [volume, setVolume] = useState(() => readStored("volume", 1));
  const [muted, setMuted] = useState(() => readStored("muted", 0) === 1);
  const [playbackRate, setPlaybackRate] = useState(() => readStored("playbackRate", 1));
  const [follow, setFollow] = useState(true);

  // An open menu suspends the editor shortcuts, so `S` picks a menu item rather
  // than splitting a cue.
  const [menuOpen, setMenuOpen] = useState(false);
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

  // --- Transport ----------------------------------------------------------
  // Loading a new source resets volume/rate on the element, so re-apply on
  // `loadeddata` as well as whenever the values change.
  useEffect(() => {
    if (!videoEl) return;
    const apply = () => {
      videoEl.volume = clamp(volume, 0, 1);
      videoEl.muted = muted;
      videoEl.playbackRate = playbackRate;
    };
    apply();
    videoEl.addEventListener("loadeddata", apply);
    return () => videoEl.removeEventListener("loadeddata", apply);
  }, [videoEl, volume, muted, playbackRate, videoUrl]);

  useEffect(() => writeStored("volume", volume), [volume]);
  useEffect(() => writeStored("muted", muted ? 1 : 0), [muted]);
  useEffect(() => writeStored("playbackRate", playbackRate), [playbackRate]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  }, []);

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
  /**
   * Attaches a video to the panes without touching the cue data, so both
   * "open a video" and "open a project" can use it. Returns the derived paths.
   */
  const attachMedia = useCallback(async (path: string) => {
    const info = await api.probeMedia(path);
    const derived = await api.derivePaths(path);

    setMedia(info);
    setPaths(derived);
    setVideoUrl(convertFileSrc(path));
    setPeaks(null);
    setCurrentTime(0);
    setSelectedCueId(null);
    return { info, derived };
  }, []);

  /** Clears the media panes — a project whose video has gone missing, or New. */
  const detachMedia = useCallback(() => {
    setMedia(null);
    setPaths(null);
    setVideoUrl(null);
    setPeaks(null);
    setCurrentTime(0);
    setSelectedCueId(null);
  }, []);

  const openVideoAt = useCallback(
    async (path: string) => {
      try {
        const { info, derived } = await attachMedia(path);
        // A bare video starts an untitled project; Save As names it. A sibling
        // .sstproj adopts its name instead.
        let adopted: string | null = null;

        // Sibling project file, then the legacy sidecar (it has speakers), then
        // a sibling .srt.
        let loaded: Project = { videoPath: path, cues: [], speakers: [] };
        if (await api.fileExists(derived.project)) {
          const raw = await api.readTextFile(derived.project);
          loaded = { ...parseProjectFile(raw), videoPath: path };
          adopted = derived.project;
          notify(
            `Opened ${projectName(derived.project)} with ${loaded.cues.length} cues.`,
          );
        } else if (await api.fileExists(derived.sidecar)) {
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
          notify("Video opened. No matching project or .srt found.");
        }

        load(loaded);
        setProjectPath(adopted);
        if (loaded.cues.length > 0) setSelectedCueId(loaded.cues[0].id);

        // One write to the app state, so the two calls cannot race each other.
        const stateCall = adopted
          ? api.rememberProject(adopted, path)
          : api.clearLastProject();
        stateCall.then(setAppState).catch(() => undefined);

        if (!info.hasAudio) {
          notify("This file has no audio track, so there is no waveform.", "error");
        }
      } catch (e) {
        notify(errorMessage(e), "error");
      }
    },
    [attachMedia, load, notify],
  );

  // --- Projects -----------------------------------------------------------
  /**
   * True when it is safe to throw the current project away. `dirty` is read
   * through a ref because the callers are memoised on identities that must not
   * change on every edit.
   */
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const confirmDiscard = useCallback(async () => {
    if (!dirtyRef.current) return true;
    return ask("This project has unsaved changes. Discard them?", {
      title: "Unsaved changes",
      kind: "warning",
      okLabel: "Discard",
      cancelLabel: "Cancel",
    });
  }, []);

  const openProjectAt = useCallback(
    async (path: string) => {
      try {
        const raw = await api.readTextFile(path);
        const loaded = parseProjectFile(raw);

        if (loaded.videoPath && (await api.fileExists(loaded.videoPath))) {
          const { info } = await attachMedia(loaded.videoPath);
          if (!info.hasAudio) {
            notify("This file has no audio track, so there is no waveform.", "error");
          }
        } else {
          detachMedia();
          notify(
            loaded.videoPath
              ? `The video ${loaded.videoPath} is missing. Cues loaded — use "Locate video…" to point at it.`
              : "This project has no video attached.",
            "error",
          );
        }

        load(loaded);
        setProjectPath(path);
        if (loaded.cues.length > 0) setSelectedCueId(loaded.cues[0].id);
        api.rememberProject(path, loaded.videoPath).then(setAppState).catch(() => undefined);
      } catch (e) {
        // A project that cannot be read is not worth offering again.
        api.forgetProject(path).then(setAppState).catch(() => undefined);
        notify(`Could not open ${path}: ${errorMessage(e)}`, "error");
      }
    },
    [attachMedia, detachMedia, load, notify],
  );

  const openProject = useCallback(async () => {
    if (!(await confirmDiscard())) return;
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "sub-sub-title project", extensions: [PROJECT_EXTENSION] }],
    });
    if (typeof picked === "string") await openProjectAt(picked);
  }, [confirmDiscard, openProjectAt]);

  const openRecent = useCallback(
    async (path: string) => {
      if (!(await confirmDiscard())) return;
      await openProjectAt(path);
    },
    [confirmDiscard, openProjectAt],
  );

  const newProject = useCallback(async () => {
    if (!(await confirmDiscard())) return;
    detachMedia();
    setProjectPath(null);
    load(emptyProject);
    api.clearLastProject().then(setAppState).catch(() => undefined);
    notify("New project. Open a video to get started.");
  }, [confirmDiscard, detachMedia, load, notify]);

  // Opened via "Open with" in Explorer, a path on the command line, or — failing
  // that — the project that was open when the app last closed.
  const openedStartupFile = useRef(false);
  useEffect(() => {
    if (openedStartupFile.current) return;
    openedStartupFile.current = true;

    void (async () => {
      const startup = await api.startupFile().catch(() => null);
      if (startup) {
        if (startup.toLowerCase().endsWith(`.${PROJECT_EXTENSION}`)) {
          await openProjectAt(startup);
        } else {
          await openVideoAt(startup);
        }
        return;
      }

      const state = await api.loadAppState().catch(() => null);
      if (!state) return;
      setAppState(state);
      if (state.lastProject && (await api.fileExists(state.lastProject))) {
        await openProjectAt(state.lastProject);
      } else if (state.lastProject) {
        api.forgetProject(state.lastProject).then(setAppState).catch(() => undefined);
      }
    })();
  }, [openProjectAt, openVideoAt]);

  const chooseVideo = useCallback(async () => {
    if (!(await confirmDiscard())) return;
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
    });
    if (typeof picked === "string") await openVideoAt(picked);
  }, [confirmDiscard, openVideoAt]);

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
  const writeProjectTo = useCallback(
    async (target: string) => {
      try {
        await api.writeTextFile(target, serializeProjectFile(project));
        markSaved(project);
        setProjectPath(target);
        api
          .rememberProject(target, project.videoPath)
          .then(setAppState)
          .catch(() => undefined);
        notify(`Saved ${projectName(target)}.${PROJECT_EXTENSION}`);
      } catch (e) {
        notify(errorMessage(e), "error");
      }
    },
    [project, markSaved, notify],
  );

  const saveProjectAs = useCallback(async () => {
    const target = await saveDialog({
      defaultPath: projectPath ?? paths?.project,
      filters: [{ name: "sub-sub-title project", extensions: [PROJECT_EXTENSION] }],
    });
    if (!target) return;
    // The dialog usually appends the filter's extension, but a typed name with
    // no extension comes back bare.
    const withExtension = target.toLowerCase().endsWith(`.${PROJECT_EXTENSION}`)
      ? target
      : `${target}.${PROJECT_EXTENSION}`;
    await writeProjectTo(withExtension);
  }, [projectPath, paths, writeProjectTo]);

  const saveProject = useCallback(async () => {
    if (projectPath) return writeProjectTo(projectPath);
    await saveProjectAs();
  }, [projectPath, writeProjectTo, saveProjectAs]);

  /** Re-points a project at a video that was moved or renamed. */
  const relocateVideo = useCallback(async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
    });
    if (typeof picked !== "string") return;
    try {
      const { info } = await attachMedia(picked);
      update((current) => ({ ...current, videoPath: picked }));
      if (!info.hasAudio) {
        notify("This file has no audio track, so there is no waveform.", "error");
      } else {
        notify("Video relocated. Save the project to keep the new path.");
      }
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }, [attachMedia, update, notify]);

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

  // --- Drag and drop ------------------------------------------------------
  const openDroppedPaths = useCallback(
    async (paths: string[]) => {
      const intent = classifyDrop(paths);
      if (intent.kind === "project") {
        if (!(await confirmDiscard())) return;
        return openProjectAt(intent.path);
      }

      if (intent.kind === "video") {
        if (!(await confirmDiscard())) return;
        return openVideoAt(intent.path);
      }

      if (intent.kind === "srt") {
        if (!project.videoPath) {
          return notify("Open a video before dropping subtitles onto it.", "error");
        }
        return importSrtFrom(intent.path);
      }

      notify(
        "Drop a project, a video, or an .srt to import cues into the open video.",
        "error",
      );
    },
    [confirmDiscard, openProjectAt, openVideoAt, importSrtFrom, project.videoPath, notify],
  );

  useEffect(() => {
    // Tauri's own drag-drop events; the webview's HTML5 ones are suppressed
    // while this is enabled, so file paths arrive here rather than as File
    // objects (which would have no usable path for ffmpeg).
    const pending = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over" || event.payload.type === "enter") {
        setDropActive(true);
      } else if (event.payload.type === "drop") {
        setDropActive(false);
        void openDroppedPaths(event.payload.paths);
      } else {
        setDropActive(false);
      }
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [openDroppedPaths]);

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

  // --- Cue actions --------------------------------------------------------
  // Shared by the Edit menu and the keyboard shortcuts, so the two can never
  // drift apart.
  const splitAtPlayhead = useCallback(() => {
    if (!selectedCueId) return;
    const result = splitCueAt(cues, selectedCueId, currentTime);
    if (!result.newCueId) {
      return notify("Move the playhead inside the selected cue to split it.", "error");
    }
    setCues(() => result.cues);
    setSelectedCueId(result.newCueId);
  }, [cues, selectedCueId, currentTime, setCues, notify]);

  const mergeSelectedWithNext = useCallback(() => {
    if (!selectedCueId) return;
    setCues((list) => mergeWithNext(list, selectedCueId));
  }, [selectedCueId, setCues]);

  const newCueAtPlayhead = useCallback(() => {
    const end = Math.min(currentTime + 2, duration || currentTime + 2);
    createCue(currentTime, end);
  }, [currentTime, duration, createCue]);

  const deleteSelected = useCallback(() => {
    if (!selectedCueId) return;
    const index = cues.findIndex((c) => c.id === selectedCueId);
    setCues((list) => list.filter((c) => c.id !== selectedCueId));
    const nextSelection = cues[index + 1] ?? cues[index - 1] ?? null;
    setSelectedCueId(nextSelection?.id ?? null);
  }, [cues, selectedCueId, setCues]);

  const zoomBy = useCallback((direction: number) => {
    setZoom((z) =>
      clamp(Math.round(z * (direction > 0 ? 1.4 : 1 / 1.4)), MIN_ZOOM, MAX_ZOOM),
    );
  }, []);

  // --- Window title and close guard ---------------------------------------
  useEffect(() => {
    const name = projectPath ? projectName(projectPath) : "Untitled";
    void getCurrentWindow()
      .setTitle(`${name}${dirty ? " •" : ""} — sub-sub-title`)
      .catch(() => undefined);
  }, [projectPath, dirty]);

  useEffect(() => {
    const pending = getCurrentWindow().onCloseRequested(async (event) => {
      // Always take the close back: the confirmation is async, so the window
      // would otherwise be gone before the answer arrives.
      event.preventDefault();
      if (await confirmDiscard()) await getCurrentWindow().destroy();
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [confirmDiscard]);

  // --- Shortcuts ----------------------------------------------------------
  const modalOpen = showSettings || showHelp || showRender;

  useShortcuts(
    {
      togglePlay,
      assignSpeakerIndex: (index) => {
        const speaker = speakers[index];
        if (!speaker || !selectedCueId) return;
        assignSpeaker(selectedCueId, speaker.id);
      },
      clearSpeaker: () => {
        if (selectedCueId) assignSpeaker(selectedCueId, null);
      },
      splitAtPlayhead,
      mergeWithNext: mergeSelectedWithNext,
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
      newCueAtPlayhead,
      deleteSelected,
      generateContinuation: () => {
        if (generateRef.current) generateRef.current();
        else notify("Add an OpenRouter API key in Settings first.", "error");
      },
      save: () => void saveProject(),
      saveAs: () => void saveProjectAs(),
      newProject: () => void newProject(),
      openProject: () => void openProject(),
      undo,
      redo,
      zoom: zoomBy,
      toggleFollow: () => setFollow((f) => !f),
      showHelp: () => setShowHelp(true),
    },
    !modalOpen && !menuOpen,
  );

  // --- Render -------------------------------------------------------------
  const activeSpeaker =
    speakers.find((s) => s.id === activeCue?.speakerId) ?? null;
  /** There is something worth writing to disk. */
  const hasProject = Boolean(paths) || cues.length > 0 || speakers.length > 0;

  const menus: Menu[] = [
    {
      label: "File",
      entries: [
        { kind: "item", label: "New project", accelerator: "Ctrl+N", onSelect: () => void newProject() },
        {
          kind: "item",
          label: "Open project…",
          accelerator: "Ctrl+O",
          onSelect: () => void openProject(),
        },
        {
          kind: "submenu",
          label: "Open recent",
          disabled: appState.recentProjects.length === 0,
          entries: appState.recentProjects.map((entry) => ({
            kind: "item" as const,
            label: projectName(entry.path),
            detail: entry.path,
            checked: entry.path === projectPath,
            disabled: entry.path === projectPath,
            onSelect: () => void openRecent(entry.path),
          })),
        },
        { kind: "separator" },
        { kind: "item", label: "Open video…", onSelect: () => void chooseVideo() },
        {
          kind: "item",
          label: "Locate video…",
          disabled: !projectPath || Boolean(videoUrl),
          onSelect: () => void relocateVideo(),
        },
        { kind: "separator" },
        {
          kind: "item",
          label: dirty ? "Save •" : "Save",
          accelerator: "Ctrl+S",
          disabled: !hasProject,
          onSelect: () => void saveProject(),
        },
        {
          kind: "item",
          label: "Save as…",
          accelerator: "Ctrl+Shift+S",
          disabled: !hasProject,
          onSelect: () => void saveProjectAs(),
        },
        { kind: "separator" },
        {
          kind: "item",
          label: "Import .srt…",
          disabled: !paths,
          onSelect: () => void importSrt(),
        },
        {
          kind: "item",
          label: "Export .srt…",
          disabled: cues.length === 0,
          onSelect: () => void exportSrt(),
        },
        {
          kind: "item",
          label: "Export .ass…",
          disabled: cues.length === 0,
          onSelect: () => void exportAss(),
        },
        {
          kind: "item",
          label: "Burn in…",
          disabled: cues.length === 0 || !tools?.ffmpeg,
          onSelect: () => setShowRender(true),
        },
        { kind: "separator" },
        { kind: "item", label: "Settings…", onSelect: () => setShowSettings(true) },
        // Goes through the same close guard as the window's own close button.
        {
          kind: "item",
          label: "Exit",
          onSelect: () => void getCurrentWindow().close(),
        },
      ],
    },
    {
      label: "Edit",
      entries: [
        { kind: "item", label: "Undo", accelerator: "Ctrl+Z", disabled: !canUndo, onSelect: undo },
        { kind: "item", label: "Redo", accelerator: "Ctrl+Y", disabled: !canRedo, onSelect: redo },
        { kind: "separator" },
        {
          kind: "item",
          label: "New cue at playhead",
          accelerator: "N",
          disabled: !media,
          onSelect: newCueAtPlayhead,
        },
        {
          kind: "item",
          label: "Split at playhead",
          accelerator: "S",
          disabled: !selectedCueId,
          onSelect: splitAtPlayhead,
        },
        {
          kind: "item",
          label: "Merge with next",
          accelerator: "M",
          disabled: !selectedCueId,
          onSelect: mergeSelectedWithNext,
        },
        {
          kind: "item",
          label: "Delete cue",
          accelerator: "Del",
          disabled: !selectedCueId,
          onSelect: deleteSelected,
        },
      ],
    },
    {
      label: "View",
      entries: [
        { kind: "item", label: "Zoom in", accelerator: "+", onSelect: () => zoomBy(1) },
        { kind: "item", label: "Zoom out", accelerator: "−", onSelect: () => zoomBy(-1) },
        { kind: "separator" },
        {
          kind: "item",
          label: "Follow playhead",
          accelerator: "F",
          checked: follow,
          onSelect: () => setFollow((f) => !f),
        },
      ],
    },
    {
      label: "Help",
      entries: [
        {
          kind: "item",
          label: "Keyboard shortcuts",
          accelerator: "?",
          onSelect: () => setShowHelp(true),
        },
      ],
    },
  ];

  return (
    <div className="app">
      <header className="toolbar">
        <MenuBar menus={menus} onOpenChange={setMenuOpen} />

        <div className="toolbar-spacer">
          <span className="file-label">
            {hasProject
              ? `${projectPath ? projectName(projectPath) : "Untitled"}${
                  dirty ? " •" : ""
                } — ${paths ? `${paths.stem} · ` : ""}${cues.length} cues`
              : "No project"}
            {peaksBusy && " · extracting waveform…"}
          </span>
        </div>

        <div className="toolbar-group">
          <label className="zoom-control" title="Waveform zoom">
            <span>Zoom</span>
            <input
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
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

          <TransportBar
            enabled={Boolean(videoUrl)}
            playing={playing}
            currentTime={currentTime}
            duration={duration}
            volume={volume}
            muted={muted}
            playbackRate={playbackRate}
            onTogglePlay={togglePlay}
            onVolumeChange={(v) => {
              setVolume(v);
              // Dragging the slider up is an unmute in every player.
              if (v > 0 && muted) setMuted(false);
            }}
            onToggleMute={() => setMuted((m) => !m)}
            onPlaybackRateChange={setPlaybackRate}
          />

          <WaveformPane
            videoEl={videoEl}
            peaks={peaks}
            duration={duration}
            cues={cues}
            speakers={speakers}
            selectedCueId={selectedCueId}
            zoom={zoom}
            follow={follow}
            onSelectCue={setSelectedCueId}
            onRetimeCue={(id, start, end) => retimeFromWaveform(id, start, end)}
            onCreateCue={createCue}
            // Clicking a region must move the video, not just the app's clock.
            onSeek={seek}
            onZoomChange={setZoom}
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

      {dropActive && (
        <div className="drop-overlay">
          <div className="drop-card">
            <strong>Drop to open</strong>
            <span>A video replaces the project; an .srt imports cues into it.</span>
          </div>
        </div>
      )}

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
