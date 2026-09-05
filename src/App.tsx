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
import type { Menu, MenuEntry } from "./components/MenuBar";
import { ContextMenu } from "./components/ContextMenu";
import type { ContextMenuState } from "./components/ContextMenu";
import { FindBar } from "./components/FindBar";
import { ProofreadDialog } from "./components/ProofreadDialog";

import { emptyProject, useProjectHistory } from "./state/useProjectHistory";
import { useShortcuts } from "./hooks/useShortcuts";
import { useCueSelection } from "./hooks/useCueSelection";
import { useSpellcheck } from "./hooks/useSpellcheck";

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
  DEFAULT_MIN_GAP,
  duplicateCue,
  findActiveCueIndex,
  findOverlaps,
  insertCue,
  insertCueClamped,
  joinCues,
  mergeWithNext,
  moveCueTo,
  moveCuesBy,
  newCue,
  resizeCue,
  resolveOverlaps,
  slotAfter,
  sortCues,
  splitCueAt,
} from "./lib/cues";
import {
  DEFAULT_MAX_CHARS_PER_LINE,
  DEFAULT_MAX_LINES,
  matchesQuery,
  replaceIn,
} from "./lib/text";
import {
  applyReplacement,
  isSingleWord,
  issueSeverity,
  replacementLabel,
} from "./lib/issues";
import type {
  AppState,
  Cue,
  CueIssue,
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
  bold: false,
  outline: 2,
  outlineColor: "#000000",
  shadow: 0,
  shadowColor: "#000000",
  peaksResolution: 80,
  minGap: DEFAULT_MIN_GAP,
  maxCharsPerLine: DEFAULT_MAX_CHARS_PER_LINE,
  maxLines: DEFAULT_MAX_LINES,
  spellcheck: true,
  dialect: "american",
};

interface FindState {
  query: string;
  replacement: string;
  matchCase: boolean;
}

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
  const [showProofread, setShowProofread] = useState(false);
  /** The user's personal word list, shared by every project. */
  const [userDictionary, setUserDictionary] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [find, setFind] = useState<FindState | null>(null);
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

  const {
    selectedIds,
    primaryId,
    select,
    selectOnly,
    selectAll,
    clear: clearSelection,
  } = useCueSelection(cues);

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
    api.loadUserDictionary().then(setUserDictionary).catch(() => undefined);
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
    () => cues.find((c) => c.id === primaryId) ?? null,
    [cues, primaryId],
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
    clearSelection();
    return { info, derived };
  }, []);

  /** Clears the media panes — a project whose video has gone missing, or New. */
  const detachMedia = useCallback(() => {
    setMedia(null);
    setPaths(null);
    setVideoUrl(null);
    setPeaks(null);
    setCurrentTime(0);
    clearSelection();
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
        if (loaded.cues.length > 0) selectOnly(loaded.cues[0].id);

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
        if (loaded.cues.length > 0) selectOnly(loaded.cues[0].id);
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

  const minGap = settings.minGap;

  /** Typed timecodes are always a resize: they name both edges explicitly. */
  const editTiming = useCallback(
    (id: string, start: number, end: number) =>
      setCues((list) => resizeCue(list, id, start, end, duration, minGap)),
    [setCues, duration, minGap],
  );

  /**
   * A waveform gesture. Resizing clamps against the neighbours; dragging a
   * whole cue may cross them, and drags a multi-selection along as one block.
   */
  const retimeFromWaveform = useCallback(
    (id: string, start: number, end: number, kind: "move" | "resize") =>
      setCues((list) => {
        if (kind === "resize") return resizeCue(list, id, start, end, duration, minGap);

        const cue = list.find((c) => c.id === id);
        if (!cue) return list;
        if (selectedIds.has(id) && selectedIds.size > 1) {
          return moveCuesBy(list, selectedIds, start - cue.start, duration, minGap);
        }
        return moveCueTo(list, id, start, duration, minGap);
      }, `drag:${id}`),
    [setCues, duration, minGap, selectedIds],
  );

  const assignSpeaker = useCallback(
    (cueId: string, speakerId: string | null) =>
      setCues((list) => list.map((c) => (c.id === cueId ? { ...c, speakerId } : c))),
    [setCues],
  );

  /** Tag every selected cue at once; the whole change is one undo step. */
  const assignSpeakerToSelection = useCallback(
    (speakerId: string | null) => {
      if (selectedIds.size === 0) return;
      setCues((list) =>
        list.map((c) => (selectedIds.has(c.id) ? { ...c, speakerId } : c)),
      );
    },
    [setCues, selectedIds],
  );

  const createCue = useCallback(
    (start: number, end: number) => {
      const cue = newCue(start, end, selectedCue?.speakerId ?? null);
      let placed = false;
      setCues((list) => {
        const next = insertCueClamped(list, cue, duration, minGap);
        placed = next !== null;
        return next ?? list;
      });
      if (placed) selectOnly(cue.id);
      else notify("There is no room for a cue there.", "error");
    },
    [setCues, selectedCue, duration, minGap, selectOnly, notify],
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
        selectOnly(parsed[0].id);

        // Other tools happily emit overlapping cues; say so rather than leaving
        // the editor in a state its own rules forbid.
        const overlapping = findOverlaps(parsed, settings.minGap).length;
        notify(
          `Imported ${parsed.length} cues` +
            (warnings.length ? `; ${warnings.length} lines needed repair.` : ".") +
            (overlapping > 0
              ? ` ${overlapping} overlap — use Edit ▸ Fix overlapping cues.`
              : ""),
        );
      } catch (e) {
        notify(errorMessage(e), "error");
      }
    },
    [update, notify, selectOnly, settings.minGap],
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
      const { start, end } = slotAfter(cues, primaryId, duration);
      const cue: Cue = { id: makeId(), start, end, text, speakerId };
      setCues((list) => insertCue(list, cue));
      selectOnly(cue.id);
      notify("Added the line. Set its timing on the waveform.");
    },
    [cues, primaryId, duration, setCues, notify],
  );

  const registerGenerate = useCallback((fn: (() => void) | null) => {
    generateRef.current = fn;
  }, []);

  // --- Cue actions --------------------------------------------------------
  // Shared by the Edit menu and the keyboard shortcuts, so the two can never
  // drift apart.
  const splitAtPlayhead = useCallback(() => {
    if (!primaryId) return;
    const result = splitCueAt(cues, primaryId, currentTime);
    if (!result.newCueId) {
      return notify(
        "Move the playhead inside the selected cue, at least a tenth of a second from either end, to split it.",
        "error",
      );
    }
    setCues(() => result.cues);
    selectOnly(result.newCueId);
  }, [cues, primaryId, currentTime, setCues, notify, selectOnly]);

  /**
   * Joins the whole selection when there is one, and otherwise falls back to
   * merging the selected cue with the one after it.
   */
  const joinSelected = useCallback(() => {
    if (!primaryId) return;

    if (selectedIds.size > 1) {
      const joined = joinCues(cues, selectedIds);
      if (!joined) {
        return notify("Only neighbouring cues can be joined.", "error");
      }
      setCues(() => joined);
      selectOnly(primaryId);
      return;
    }

    const merged = mergeWithNext(cues, primaryId);
    if (merged === cues) return notify("There is no cue after this one.", "error");
    setCues(() => merged);
  }, [cues, primaryId, selectedIds, setCues, notify, selectOnly]);

  const newCueAtPlayhead = useCallback(() => {
    const end = Math.min(currentTime + 2, duration || currentTime + 2);
    createCue(currentTime, end);
  }, [currentTime, duration, createCue]);

  const duplicateSelected = useCallback(() => {
    if (!primaryId) return;
    const result = duplicateCue(cues, primaryId, duration, minGap);
    if (!result.newCueId) {
      return notify("There is no room for a copy after this cue.", "error");
    }
    setCues(() => result.cues);
    selectOnly(result.newCueId);
  }, [cues, primaryId, duration, minGap, setCues, notify, selectOnly]);

  const deleteSelected = useCallback(() => {
    if (selectedIds.size === 0) return;
    const last = cues.findIndex((c) => c.id === primaryId);
    setCues((list) => list.filter((c) => !selectedIds.has(c.id)));
    // Land on the nearest survivor, so a run of deletes keeps working.
    const after = cues.slice(last + 1).find((c) => !selectedIds.has(c.id));
    const before = [...cues.slice(0, Math.max(0, last))]
      .reverse()
      .find((c) => !selectedIds.has(c.id));
    selectOnly(after?.id ?? before?.id ?? null);
  }, [cues, primaryId, selectedIds, setCues, selectOnly]);

  const fixOverlaps = useCallback(() => {
    const overlapping = findOverlaps(cues, minGap);
    if (overlapping.length === 0) return notify("No overlapping cues.");
    setCues((list) => resolveOverlaps(list, minGap));
    notify(`Separated ${overlapping.length} overlapping cue${overlapping.length === 1 ? "" : "s"}.`);
  }, [cues, minGap, setCues, notify]);

  // --- Spelling -----------------------------------------------------------
  /** The project's own vocabulary plus the user's, as one list. */
  const ignoredWords = useMemo(
    () => [...(project.dictionary ?? []), ...userDictionary],
    [project.dictionary, userDictionary],
  );

  const spellcheck = useSpellcheck({
    cues,
    enabled: settings.spellcheck,
    dialect: settings.dialect,
    ignored: ignoredWords,
  });

  /** Splice one suggestion into its cue. One undo entry, like any other edit. */
  const applyIssue = useCallback(
    (cueId: string, issue: CueIssue, replacement: string) => {
      setCues((list) =>
        list.map((c) =>
          c.id === cueId ? { ...c, text: applyReplacement(c.text, issue, replacement) } : c,
        ),
      );
    },
    [setCues],
  );

  /** Excuse a word for this project only — character names, invented places. */
  const ignoreWordInProject = useCallback(
    (word: string) => {
      update((current) => {
        const existing = current.dictionary ?? [];
        if (existing.some((w) => w.toLowerCase() === word.toLowerCase())) return current;
        return { ...current, dictionary: [...existing, word] };
      });
      notify(`“${word}” will be ignored in this project. Save to keep it.`);
    },
    [update, notify],
  );

  /** Excuse a word everywhere, in every project on this machine. */
  const addWordToDictionary = useCallback(
    (word: string) => {
      const next = [...userDictionary, word];
      setUserDictionary(next);
      api
        .saveUserDictionary(next)
        .then(() => notify(`“${word}” added to your dictionary.`))
        .catch((e) => notify(errorMessage(e), "error"));
    },
    [userDictionary, notify],
  );

  // --- Find and replace ---------------------------------------------------
  const matches = useMemo(() => {
    if (!find || find.query === "") return [];
    return cues.filter((c) => matchesQuery(c.text, find.query, find.matchCase));
  }, [cues, find]);

  const matchIds = useMemo(
    () => (matches.length > 0 ? new Set(matches.map((c) => c.id)) : null),
    [matches],
  );

  const stepMatch = useCallback(
    (direction: 1 | -1) => {
      if (matches.length === 0) return;
      const at = matches.findIndex((c) => c.id === primaryId);
      const next =
        at === -1
          ? matches[direction === 1 ? 0 : matches.length - 1]
          : matches[(at + direction + matches.length) % matches.length];
      selectOnly(next.id);
      seek(next.start);
    },
    [matches, primaryId, selectOnly, seek],
  );

  const replaceOne = useCallback(() => {
    if (!find || matches.length === 0) return;
    const target = matches.find((c) => c.id === primaryId) ?? matches[0];
    setCues((list) =>
      list.map((c) =>
        c.id === target.id
          ? { ...c, text: replaceIn(c.text, find.query, find.replacement, find.matchCase) }
          : c,
      ),
    );
    selectOnly(target.id);
  }, [find, matches, primaryId, setCues, selectOnly]);

  const replaceAll = useCallback(() => {
    if (!find || matches.length === 0) return;
    const count = matches.length;
    setCues((list) =>
      list.map((c) =>
        matchesQuery(c.text, find.query, find.matchCase)
          ? { ...c, text: replaceIn(c.text, find.query, find.replacement, find.matchCase) }
          : c,
      ),
    );
    notify(`Replaced in ${count} cue${count === 1 ? "" : "s"}.`);
  }, [find, matches, setCues, notify]);

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
  const modalOpen = showSettings || showHelp || showRender || showProofread;

  useShortcuts(
    {
      togglePlay,
      assignSpeakerIndex: (index) => {
        const speaker = speakers[index];
        if (speaker) assignSpeakerToSelection(speaker.id);
      },
      clearSpeaker: () => assignSpeakerToSelection(null),
      splitAtPlayhead,
      mergeWithNext: joinSelected,
      nudge: (edge, direction) => {
        if (!primaryId) return;
        const delta = direction * frameStep;
        setCues((list) => {
          // Moving the whole cue carries the rest of the selection with it;
          // an edge belongs to the one cue that owns it.
          if (edge === "both") {
            return moveCuesBy(list, selectedIds, delta, duration, minGap);
          }
          const cue = list.find((c) => c.id === primaryId);
          if (!cue) return list;
          const start = edge === "start" ? cue.start + delta : cue.start;
          const end = edge === "end" ? cue.end + delta : cue.end;
          return resizeCue(list, primaryId, start, end, duration, minGap);
        }, `nudge:${primaryId}:${edge}`);
      },
      selectPrevious: () => {
        const index = cues.findIndex((c) => c.id === primaryId);
        const target = index > 0 ? cues[index - 1] : cues[0];
        if (target) selectOnly(target.id);
      },
      selectNext: () => {
        const index = cues.findIndex((c) => c.id === primaryId);
        const target = index >= 0 ? cues[index + 1] : cues[0];
        if (target) selectOnly(target.id);
      },
      jumpToSelected: () => {
        if (selectedCue) seek(selectedCue.start);
      },
      newCueAtPlayhead,
      duplicateSelected,
      deleteSelected,
      selectAll,
      clearSelection: () => {
        // Escape backs out of whatever is in the way, innermost first.
        if (contextMenu) setContextMenu(null);
        else if (find) setFind(null);
        else clearSelection();
      },
      openFind: () =>
        setFind((current) => current ?? { query: "", replacement: "", matchCase: false }),
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
    !modalOpen && !menuOpen && !contextMenu,
  );

  // --- Context menu -------------------------------------------------------
  /**
   * Right-clicking a cue that is not in the selection selects it first, so the
   * menu always acts on what the user is looking at.
   */
  const openCueContextMenu = useCallback(
    (cueId: string, x: number, y: number) => {
      const inSelection = selectedIds.has(cueId);
      if (!inSelection) selectOnly(cueId);

      const targets = inSelection ? selectedIds : new Set([cueId]);
      const many = targets.size > 1;
      const cue = cues.find((c) => c.id === cueId) ?? null;
      const suffix = many ? ` ${targets.size} cues` : "";

      // Spelling comes first: it is what the badge was clicked for, and what
      // the eye goes to when the row is flagged.
      const issues = cue && !many ? spellcheck.issuesFor(cue) : [];
      const spellingEntries: MenuEntry[] = issues.flatMap((issue) => {
        const fixes: MenuEntry[] = issue.replacements.slice(0, 4).map((replacement) => ({
          kind: "item" as const,
          label: replacementLabel(issue, replacement),
          detail: issue.source === "ai" ? replacement : issue.message,
          onSelect: () => cue && applyIssue(cue.id, issue, replacement),
        }));

        if (fixes.length === 0) {
          // A lint with no fix still deserves to be visible and dismissable.
          fixes.push({
            kind: "item",
            label: `${issue.text}: ${issue.message}`,
            disabled: true,
            onSelect: () => undefined,
          });
        }

        if (issue.source === "harper" && isSingleWord(issue)) {
          fixes.push({
            kind: "item",
            label: `Ignore “${issue.text}” in this project`,
            onSelect: () => ignoreWordInProject(issue.text),
          });
          fixes.push({
            kind: "item",
            label: `Add “${issue.text}” to dictionary`,
            onSelect: () => addWordToDictionary(issue.text),
          });
        }
        return fixes;
      });

      const entries: MenuEntry[] = [
        // More than one issue would make a long flat menu; nest them.
        ...(issues.length === 1
          ? spellingEntries
          : issues.length > 1
            ? issues.map((issue) => ({
                kind: "submenu" as const,
                label: `${issueSeverity(issue) === "suggestion" ? "Correction" : issue.text}: ${issue.message}`,
                entries: [
                  ...issue.replacements.slice(0, 4).map((replacement) => ({
                    kind: "item" as const,
                    label: replacementLabel(issue, replacement),
                    detail: issue.source === "ai" ? replacement : undefined,
                    onSelect: () => cue && applyIssue(cue.id, issue, replacement),
                  })),
                  ...(issue.source === "harper" && isSingleWord(issue)
                    ? [
                        {
                          kind: "item" as const,
                          label: `Ignore “${issue.text}” in this project`,
                          onSelect: () => ignoreWordInProject(issue.text),
                        },
                        {
                          kind: "item" as const,
                          label: `Add “${issue.text}” to dictionary`,
                          onSelect: () => addWordToDictionary(issue.text),
                        },
                      ]
                    : []),
                ],
              }))
            : []),
        ...(issues.length > 0 ? [{ kind: "separator" as const }] : []),
        {
          kind: "item",
          label: "Play from here",
          onSelect: () => cue && seek(cue.start),
        },
        { kind: "separator" },
        {
          kind: "item",
          label: "Set start to playhead",
          disabled: many || !cue,
          onSelect: () => cue && editTiming(cue.id, currentTime, cue.end),
        },
        {
          kind: "item",
          label: "Set end to playhead",
          disabled: many || !cue,
          onSelect: () => cue && editTiming(cue.id, cue.start, currentTime),
        },
        { kind: "separator" },
        {
          kind: "item",
          label: "Split at playhead",
          accelerator: "S",
          disabled: many,
          onSelect: splitAtPlayhead,
        },
        {
          kind: "item",
          label: many ? `Join${suffix}` : "Join with next",
          accelerator: "M",
          onSelect: joinSelected,
        },
        {
          kind: "item",
          label: "Duplicate",
          accelerator: "Ctrl+D",
          disabled: many,
          onSelect: duplicateSelected,
        },
        { kind: "separator" },
        {
          kind: "submenu",
          label: many ? `Assign speaker to${suffix}` : "Assign speaker",
          entries: [
            ...speakers.map((speaker, index) => ({
              kind: "item" as const,
              label: speaker.name,
              accelerator: index < 9 ? String(index + 1) : undefined,
              checked: cue?.speakerId === speaker.id,
              onSelect: () => assignSpeakerToSelection(speaker.id),
            })),
            ...(speakers.length > 0 ? [{ kind: "separator" as const }] : []),
            {
              kind: "item" as const,
              label: "None",
              accelerator: "0",
              onSelect: () => assignSpeakerToSelection(null),
            },
          ],
        },
        { kind: "separator" },
        {
          kind: "item",
          label: many ? `Delete${suffix}` : "Delete cue",
          accelerator: "Del",
          onSelect: deleteSelected,
        },
      ];

      setContextMenu({ x, y, entries });
    },
    [
      cues,
      speakers,
      selectedIds,
      selectOnly,
      seek,
      currentTime,
      editTiming,
      splitAtPlayhead,
      joinSelected,
      duplicateSelected,
      assignSpeakerToSelection,
      deleteSelected,
      spellcheck,
      applyIssue,
      ignoreWordInProject,
      addWordToDictionary,
    ],
  );

  // The webview's own menu is a browser menu (Reload, Inspect) that has no
  // place in an editor — except inside text fields, where Cut/Paste earn it.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // --- Render -------------------------------------------------------------
  const activeSpeaker =
    speakers.find((s) => s.id === activeCue?.speakerId) ?? null;
  /** There is something worth writing to disk. */
  const hasProject = Boolean(paths) || cues.length > 0 || speakers.length > 0;
  const selectionLabel = selectedIds.size > 1 ? ` ${selectedIds.size} cues` : " cue";

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
            detailIsPath: true,
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
          disabled: !primaryId,
          onSelect: splitAtPlayhead,
        },
        {
          kind: "item",
          label: selectedIds.size > 1 ? `Join${selectionLabel}` : "Join with next",
          accelerator: "M",
          disabled: !primaryId,
          onSelect: joinSelected,
        },
        {
          kind: "item",
          label: "Duplicate cue",
          accelerator: "Ctrl+D",
          disabled: !primaryId,
          onSelect: duplicateSelected,
        },
        {
          kind: "item",
          label: `Delete${selectionLabel}`,
          accelerator: "Del",
          disabled: !primaryId,
          onSelect: deleteSelected,
        },
        { kind: "separator" },
        {
          kind: "item",
          label: "Select all cues",
          accelerator: "Ctrl+A",
          disabled: cues.length === 0,
          onSelect: selectAll,
        },
        {
          kind: "item",
          label: "Find and replace…",
          accelerator: "Ctrl+F",
          disabled: cues.length === 0,
          onSelect: () =>
            setFind(
              (current) => current ?? { query: "", replacement: "", matchCase: false },
            ),
        },
        {
          kind: "item",
          label: "Fix overlapping cues",
          disabled: cues.length < 2,
          onSelect: fixOverlaps,
        },
        { kind: "separator" },
        {
          kind: "item",
          label: "Proofread with AI…",
          detail: apiKeySet ? undefined : "Add an OpenRouter key in Settings",
          disabled: cues.length === 0 || !apiKeySet,
          onSelect: () => setShowProofread(true),
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
        { kind: "separator" },
        {
          kind: "item",
          label: "Check spelling",
          detail:
            settings.spellcheck && spellcheck.totalIssues > 0
              ? `${spellcheck.totalIssues} in ${spellcheck.cuesWithIssues} cues`
              : undefined,
          checked: settings.spellcheck,
          onSelect: () => {
            const next = { ...settings, spellcheck: !settings.spellcheck };
            setSettings(next);
            api.saveSettings(next).catch((e) => notify(errorMessage(e), "error"));
          },
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
            selectedIds={selectedIds}
            zoom={zoom}
            follow={follow}
            onSelectCue={select}
            onRetimeCue={retimeFromWaveform}
            onCreateCue={createCue}
            onContextMenuCue={openCueContextMenu}
            // Clicking a region must move the video, not just the app's clock.
            onSeek={seek}
            onZoomChange={setZoom}
          />
        </div>

        <aside className="side-column">
          <SpeakerPanel
            speakers={speakers}
            cues={cues}
            selectedCount={selectedIds.size}
            onAdd={addSpeaker}
            onUpdate={updateSpeaker}
            onRemove={removeSpeaker}
            onAssignToSelected={assignSpeakerToSelection}
            onApplyDetected={applyDetectedSpeakers}
          />

          <ContinuePanel
            cues={cues}
            speakers={speakers}
            selectedCueId={primaryId}
            settings={settings}
            apiKeySet={apiKeySet}
            onAccept={acceptGenerated}
            onOpenSettings={() => setShowSettings(true)}
            registerGenerate={registerGenerate}
          />
        </aside>

        <section className="list-row">
          {find && (
            <FindBar
              query={find.query}
              replacement={find.replacement}
              matchCase={find.matchCase}
              matchCount={matches.length}
              position={Math.max(0, matches.findIndex((c) => c.id === primaryId) + 1)}
              onQueryChange={(query) => setFind((f) => f && { ...f, query })}
              onReplacementChange={(replacement) =>
                setFind((f) => f && { ...f, replacement })
              }
              onMatchCaseChange={(matchCase) => setFind((f) => f && { ...f, matchCase })}
              onStep={stepMatch}
              onReplaceOne={replaceOne}
              onReplaceAll={replaceAll}
              onClose={() => setFind(null)}
            />
          )}

          <CueList
            cues={cues}
            speakers={speakers}
            selectedIds={selectedIds}
            primaryId={primaryId}
            activeCueId={activeCue?.id ?? null}
            matchIds={matchIds}
            follow={follow && playing}
            maxCharsPerLine={settings.maxCharsPerLine}
            maxLines={settings.maxLines}
            issuesFor={spellcheck.issuesFor}
            onSelect={select}
            onContextMenu={openCueContextMenu}
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

      {contextMenu && (
        <ContextMenu state={contextMenu} onClose={() => setContextMenu(null)} />
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

      {showProofread && (
        <ProofreadDialog
          cues={cues}
          selectedIds={selectedIds}
          model={settings.model}
          onApply={spellcheck.addCorrections}
          onClose={() => setShowProofread(false)}
        />
      )}

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
