import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import { TransportBar } from "./components/TransportBar";
import { VideoPane } from "./components/VideoPane";
import { MAX_ZOOM, MIN_ZOOM, WaveformPane } from "./components/WaveformPane";
import { CueList } from "./components/CueList";
import { SpeakerPanel } from "./components/SpeakerPanel";
import { StoryPanel } from "./components/StoryPanel";
import { FillDialog } from "./components/FillDialog";
import type { AcceptedFill } from "./components/FillDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { RenderDialog } from "./components/RenderDialog";
import { ExportAudioDialog } from "./components/ExportAudioDialog";
import { TtsInstallDialog } from "./components/TtsInstallDialog";
import { CastPanel } from "./components/CastPanel";
import { LineEditor } from "./components/LineEditor";
import { ReferenceDialog } from "./components/ReferenceDialog";
import {
  DEFAULT_SIDE_WIDTH,
  MAX_SIDE_WIDTH,
  MIN_SIDE_WIDTH,
  SideResizer,
} from "./components/SideResizer";
import {
  DEFAULT_CHAT_HEIGHT,
  MAX_CHAT_HEIGHT,
  MIN_CHAT_HEIGHT,
  PanelResizer,
} from "./components/PanelResizer";
import { ChatPanel } from "./components/ChatPanel";
import { MenuBar } from "./components/MenuBar";
import type { Menu, MenuEntry } from "./components/MenuBar";
import { ContextMenu } from "./components/ContextMenu";
import type { ContextMenuState } from "./components/ContextMenu";
import { FindBar } from "./components/FindBar";
import { ProofreadDialog } from "./components/ProofreadDialog";
import { TranscribeDialog } from "./components/TranscribeDialog";
import { VoiceoverTimeline } from "./components/VoiceoverTimeline";
import { ClipInspector } from "./components/ClipInspector";
import { VoiceoverMixer } from "./audio/mixer";
import {
  EMPTY_SELECTION,
  applySelection,
  pruneSelection,
  type SelectionChange,
  type VoSelection,
} from "./lib/voSelection";

import { emptyProject, useProjectHistory } from "./state/useProjectHistory";
import { useShortcuts, type ShortcutActions } from "./hooks/useShortcuts";
import { usePasteText } from "./hooks/usePasteText";
import { useCueSelection } from "./hooks/useCueSelection";
import { useSpellcheck } from "./hooks/useSpellcheck";
import { useGhostCompletion } from "./hooks/useGhostCompletion";
import { useVoiceGeneration } from "./hooks/useVoiceGeneration";

import * as api from "./lib/api";
import { errorMessage } from "./lib/api";
import { buildAss } from "./lib/ass";
import { resolveChatModel } from "./lib/chat";
import {
  mergeImportedSpeakers,
  parseSrt,
  serializeSrt,
  speakerNameOf,
  stripSpeakerPrefix,
} from "./lib/srt";
import { nextPaletteColor } from "./lib/colors";
import { classifyDrop, classifyEditDrop, VIDEO_EXTENSIONS } from "./lib/dropPaths";
import { EditWorkspace, type EditHandle } from "./components/edit/EditWorkspace";
import type { Edit, RecutKind, RecutRef } from "./types";
import { editEnd } from "./lib/edit";
import {
  cutSegments,
  describeRecut,
  hasFlags,
  previousSegments,
  recutFlag,
  recutProject,
} from "./lib/recut";

/** An edit without its re-cut report. */
function withoutRecut(edit: Edit): Edit {
  const { recut: _gone, ...rest } = edit;
  return rest;
}
import {
  PROJECT_EXTENSION,
  parseProjectFile,
  projectName,
  serializeProjectFile,
} from "./lib/projectFile";
import { makeId } from "./lib/ids";
import {
  insertSection,
  moveSection,
  newSection,
  nextSection,
  previousSection,
  removeSection,
  renameSection,
  setSectionNote,
} from "./lib/sections";
import { layoutContinuation } from "./lib/fill";
import { addBeat, editBeat, removeBeat } from "./lib/timedBeats";
import { DEFAULT_WHISPER_MODEL, formatBytes } from "./lib/whisper";
import { cueDuckCurve } from "./lib/automation";
import {
  addClips,
  addTrack,
  defaultVoiceover,
  moveClip,
  moveClipsBy,
  newClip,
  overlappingClips,
  patchClip,
  patchTrack,
  removeClip,
  patchDuck,
  removeTrack,
  setAutomation,
  toggleCueDuck,
  trimClipEnd,
  trimClipStart,
  type ClipPatch,
  type ClipWarning,
  type TrackPatch,
} from "./lib/voiceover";
import {
  MAX_STRETCH,
  NO_SPEAKER,
  addTake,
  castKey,
  clipForCue,
  currentTake,
  fitCuesToLines,
  fitRatio,
  hasSomethingToSay,
  lineIndex,
  overrun,
  referencePath,
  referenceSegments,
  removeTake,
  renderGroup,
  renderLine,
  selectTake,
  setJoin,
  setPronunciation,
  setVoice,
  setVoicing,
  speechText,
  stretchPath,
  stretchedTake,
  suggestedReferenceCues,
  voiceFilesInUse,
  voiceFor,
  voiceoverDir,
} from "./lib/tts";
import { DEFAULT_TARGET_CPS, clamp, durationForText, formatShort } from "./lib/time";
import {
  DEFAULT_MIN_GAP,
  duplicateCue,
  findActiveCueIndex,
  findOverlaps,
  fitCuesToReadingSpeed,
  insertCueClamped,
  joinCues,
  mergeWithNext,
  moveCueTo,
  moveCuesBy,
  newCue,
  resizeCue,
  resolveOverlaps,
  sortCues,
  splitCueAt,
} from "./lib/cues";
import {
  DEFAULT_MAX_CHARS_PER_LINE,
  DEFAULT_MAX_LINES,
  matchesQuery,
  replaceIn,
  wrapText,
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
  CueVoicing,
  MediaInfo,
  Project,
  ProjectPaths,
  Section,
  Settings,
  Sidecar,
  Speaker,
  TimedBeat,
  ToolStatus,
  VoiceClip,
  Voiceover,
} from "./types";

const DEFAULT_SETTINGS: Settings = {
  model: "anthropic/claude-sonnet-4.5",
  temperature: 0.9,
  fillInstructions: "",
  fillGuidanceOverride: "",
  fillLinesBefore: 24,
  fillLinesAfter: 4,
  fillTakes: 3,
  fillLatitude: "open",
  ghostEnabled: true,
  ghostModel: "google/gemini-2.5-flash-lite",
  ghostDelayMs: 350,
  ghostLinesBefore: 10,
  ghostLinesAfter: 2,
  chatLinesBefore: 10,
  chatModels: ["anthropic/claude-sonnet-4.5"],
  chatModel: "",
  chatEffort: "",
  visionModel: "",
  fontName: "Arial",
  fontSize: 48,
  bold: false,
  outline: 2,
  outlineColor: "#000000",
  shadow: 0,
  shadowColor: "#000000",
  srtSpeakerColors: true,
  peaksResolution: 80,
  minGap: DEFAULT_MIN_GAP,
  maxCharsPerLine: DEFAULT_MAX_CHARS_PER_LINE,
  maxLines: DEFAULT_MAX_LINES,
  targetCps: DEFAULT_TARGET_CPS,
  spellcheck: true,
  dialect: "american",
  whisperModel: DEFAULT_WHISPER_MODEL,
  whisperLanguage: "",
  whisperEnginePath: "",
};

interface FindState {
  query: string;
  replacement: string;
  matchCase: boolean;
}

const STORAGE_PREFIX = "sub-sub-title:";

/** localStorage can throw outright (blocked site data), so never let it escape. */
type Workspace = "subtitles" | "voiceover" | "edit";
/**
 * Stored by index. Edit came last, so it takes 2: earlier stored values still
 * restore the tab they meant, even though Edit is shown first.
 */
const WORKSPACES: Workspace[] = ["subtitles", "voiceover", "edit"];

const AUDIO_EXTENSIONS = ["wav", "mp3", "flac", "ogg", "opus", "m4a", "aac"];

/** The Voiceover workspace's side column: one panel at a time. */
type VoTab = "cast" | "line" | "clip" | "chat";
const VO_TABS: Array<{ id: VoTab; label: string; title: string }> = [
  { id: "cast", label: "Cast", title: "Who speaks how, and generating their lines" },
  { id: "line", label: "Voice line", title: "What the selected cue's line says, and how" },
  { id: "clip", label: "Clip", title: "The selected clip: its gain, its takes" },
  { id: "chat", label: "Chat", title: "Ask about or edit the script" },
];

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
  const { project, update, undo, redo, load, markSaved, dirty, canUndo, canRedo, versions } =
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
  // Stored widths are not clamped on write, so an older range cannot outlive it.
  const [sideWidth, setSideWidth] = useState(() =>
    clamp(readStored("sideWidth", DEFAULT_SIDE_WIDTH), MIN_SIDE_WIDTH, MAX_SIDE_WIDTH),
  );
  const [chatHeight, setChatHeight] = useState(() =>
    clamp(readStored("chatHeight", DEFAULT_CHAT_HEIGHT), MIN_CHAT_HEIGHT, MAX_CHAT_HEIGHT),
  );
  const [follow, setFollow] = useState(true);
  /** Which tab fills the window below the menu: subtitle editing, or the voiceover mix. */
  const [workspace, setWorkspace] = useState<Workspace>(
    () => WORKSPACES[readStored("workspace", 0)] ?? "subtitles",
  );

  // An open menu suspends the editor shortcuts, so `S` picks a menu item rather
  // than splitting a cue.
  const [menuOpen, setMenuOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showRender, setShowRender] = useState(false);
  const [showExportAudio, setShowExportAudio] = useState(false);
  const [showProofread, setShowProofread] = useState(false);
  const [showTranscribe, setShowTranscribe] = useState(false);
  /** The Fill dialog, with what it was opened on. Null while closed. */
  const [fillOpen, setFillOpen] = useState<{
    selectedCueIds: string[];
    continueAfter: number;
    initialKind: "fill" | "continue";
  } | null>(null);
  /** The user's personal word list, shared by every project. */
  const [userDictionary, setUserDictionary] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  /** The section highlighted on the timeline lane. Independent of cue selection. */
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  /** A just-created section, whose name field should take focus for typing. */
  const [renamingSectionId, setRenamingSectionId] = useState<string | null>(null);
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

  const cues = project.cues;
  const speakers = project.speakers;
  const sections = project.sections;
  const timedBeats = project.timedBeats;

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

  // --- Voiceover mixer ----------------------------------------------------
  /**
   * Created the first time the Voiceover tab opens — a click, so the audio
   * context is allowed to start — and kept from then on: once the video feeds
   * the mixer it cannot play to the speakers any other way.
   */
  const [mixer, setMixer] = useState<VoiceoverMixer | null>(null);
  const [decodeVersion, setDecodeVersion] = useState(0);
  /** Cues and clips selected on the voiceover timeline; separate from the cue list's. */
  const [voSel, setVoSel] = useState<VoSelection>(EMPTY_SELECTION);
  const selectVo = useCallback(
    (change: SelectionChange) => setVoSel((current) => applySelection(current, change)),
    [],
  );
  const voiceoverMode = workspace === "voiceover";
  const editMode = workspace === "edit";
  const editRef = useRef<EditHandle>(null);

  const [voTab, setVoTab] = useState<VoTab>(
    () => VO_TABS[readStored("voTab", 0)]?.id ?? "cast",
  );
  useEffect(
    () => writeStored("voTab", VO_TABS.findIndex((t) => t.id === voTab)),
    [voTab],
  );
  // The side column follows a click on the timeline to what was clicked: a
  // clip to its details, a cue to its voice line. Not away from the chat,
  // though, where a click is more likely to be pointing something out.
  useEffect(() => {
    const kind = voSel.primary?.kind;
    if (!kind) return;
    setVoTab((tab) => (tab === "chat" ? tab : kind === "clip" ? "clip" : "line"));
  }, [voSel.primary]);

  useEffect(() => {
    if (voiceoverMode && !mixer) setMixer(new VoiceoverMixer());
  }, [voiceoverMode, mixer]);

  useEffect(() => {
    if (!mixer) return;
    const unsubscribe = mixer.onDecoded(() => setDecodeVersion((v) => v + 1));
    return () => {
      unsubscribe();
      mixer.dispose();
    };
  }, [mixer]);

  useEffect(() => mixer?.attach(videoEl), [mixer, videoEl]);

  /** The original's duck under the cues: derived live, so it follows every cue edit. */
  const duckPoints = useMemo(
    () => cueDuckCurve(project.voiceover, project.cues),
    [project.voiceover, project.cues],
  );

  const canExportAudio = Boolean(project.videoPath && paths && tools?.ffmpeg);

  /** Loudness an export or render brings the mix to, in LUFS; 0 leaves it as mixed. */
  const [targetLufs, setTargetLufs] = useState(() => readStored("targetLufs", 0));
  useEffect(() => writeStored("targetLufs", targetLufs), [targetLufs]);

  /** The mix as the preview plays it, for an audio export or a render to use. */
  const mixdownRequest = useMemo(
    () => ({
      videoPath: project.videoPath,
      includeOriginal: media?.hasAudio ?? false,
      duration,
      tracks: project.voiceover.tracks,
      clips: project.voiceover.clips,
      duck: duckPoints,
      targetLufs: targetLufs || null,
    }),
    [project.videoPath, media?.hasAudio, duration, project.voiceover, duckPoints, targetLufs],
  );

  // Set while a cue is auditioned as a cloning reference (see `previewCue`).
  const [previewCueId, setPreviewCueId] = useState<string | null>(null);

  useEffect(() => {
    mixer?.setMix(project.voiceover, voiceoverMode && previewCueId === null, duckPoints);
  }, [mixer, project.voiceover, voiceoverMode, previewCueId, duckPoints]);

  // Decode every clip's file up front, so a reopened project draws its clip
  // waveforms and the first clip plays on time. Loads are cached per file.
  // A missing file is reported once, not on every edit that re-runs this.
  const reportedMissing = useRef(new Set<string>());
  useEffect(() => {
    if (!mixer) return;
    for (const file of new Set(project.voiceover.clips.map((c) => c.file))) {
      mixer.load(file).catch((e) => {
        if (reportedMissing.current.has(file)) return;
        reportedMissing.current.add(file);
        notify(`Could not read ${file}: ${errorMessage(e)}`, "error");
      });
    }
  }, [mixer, project.voiceover.clips, notify]);

  /**
   * What the side panels show: the primary item's clip — the clip itself, or
   * the clip holding a selected cue's line — and the primary item's cue.
   */
  const selectedClip = useMemo(() => {
    const primary = voSel.primary;
    if (!primary) return null;
    return primary.kind === "clip"
      ? project.voiceover.clips.find((c) => c.id === primary.id) ?? null
      : clipForCue(project.voiceover, primary.id) ?? null;
  }, [project.voiceover, voSel.primary]);

  // Anything removed by an undo, a delete or a load leaves the selection.
  useEffect(() => {
    setVoSel((current) =>
      pruneSelection(
        current,
        new Set(project.cues.map((c) => c.id)),
        new Set(project.voiceover.clips.map((c) => c.id)),
      ),
    );
  }, [project.cues, project.voiceover.clips]);

  // --- Transport ----------------------------------------------------------
  // Loading a new source resets volume/rate on the element, so re-apply on
  // `loadeddata` as well as whenever the values change. With the mixer in the
  // path, volume and mute belong to its master gain and the element stays at
  // full volume.
  useEffect(() => {
    if (!videoEl) return;
    const apply = () => {
      videoEl.volume = mixer ? 1 : clamp(volume, 0, 1);
      videoEl.muted = mixer ? false : muted;
      videoEl.playbackRate = playbackRate;
    };
    apply();
    mixer?.setMaster(volume, muted);
    videoEl.addEventListener("loadeddata", apply);
    return () => videoEl.removeEventListener("loadeddata", apply);
  }, [videoEl, volume, muted, playbackRate, videoUrl, mixer]);

  useEffect(() => writeStored("volume", volume), [volume]);
  useEffect(() => writeStored("muted", muted ? 1 : 0), [muted]);
  useEffect(() => writeStored("playbackRate", playbackRate), [playbackRate]);
  useEffect(() => writeStored("sideWidth", sideWidth), [sideWidth]);
  useEffect(() => writeStored("chatHeight", chatHeight), [chatHeight]);
  useEffect(() => writeStored("workspace", WORKSPACES.indexOf(workspace)), [workspace]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  }, []);

  // --- Playback position --------------------------------------------------
  /**
   * Where playback had reached, remembered per project so reopening one resumes
   * where it was left. It lives in the app state file rather than the `.sstproj`
   * on purpose: watching a video is not an edit, and writing it to the project
   * would leave every session with unsaved changes to save.
   */
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;
  const projectPathRef = useRef(projectPath);
  projectPathRef.current = projectPath;

  // Read through refs so the callback is stable, and so callers can flush the
  // outgoing project's position *before* a new video resets the clock to zero.
  const flushPosition = useCallback(() => {
    const path = projectPathRef.current;
    if (!path) return;
    api.rememberPosition(path, currentTimeRef.current).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!projectPath) return;
    // `timeupdate` fires about four times a second; a timer keeps that off disk.
    const timer = setInterval(flushPosition, 5000);
    return () => clearInterval(timer);
  }, [projectPath, flushPosition]);

  /** Set when a project is opened; applied once the element can accept a seek. */
  const [pendingPosition, setPendingPosition] = useState<number | null>(null);

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

  useEffect(() => {
    if (pendingPosition === null || !videoEl) return;
    const apply = () => {
      seek(pendingPosition);
      setPendingPosition(null);
    };
    // Setting `currentTime` before the element knows its duration is discarded,
    // and the source may or may not have loaded by the time the project does.
    if (videoEl.readyState >= HTMLMediaElement.HAVE_METADATA) {
      apply();
      return;
    }
    videoEl.addEventListener("loadedmetadata", apply, { once: true });
    return () => videoEl.removeEventListener("loadedmetadata", apply);
  }, [pendingPosition, videoEl, seek]);

  // --- Opening a video ----------------------------------------------------
  /**
   * Attaches a video to the panes without touching the cue data, so both
   * "open a video" and "open a project" can use it. Returns the derived paths.
   */
  /** The file the panes show, so a `videoPath` changed by undo can be followed. */
  const attachedPath = useRef<string | null>(null);
  const attachMedia = useCallback(async (path: string) => {
    const info = await api.probeMedia(path);
    const derived = await api.derivePaths(path);
    attachedPath.current = path;

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
    attachedPath.current = null;
    setMedia(null);
    setPaths(null);
    setVideoUrl(null);
    setPeaks(null);
    setCurrentTime(0);
    clearSelection();
  }, []);

  const openVideoAt = useCallback(
    async (path: string) => {
      flushPosition(); // Before attachMedia resets the clock. See openProjectAt.
      try {
        const { info, derived } = await attachMedia(path);
        // A bare video starts an untitled project; Save As names it. A sibling
        // .sstproj adopts its name instead.
        let adopted: string | null = null;

        // Sibling project file, then the legacy sidecar (it has speakers), then
        // a sibling .srt.
        let loaded: Project = {
          videoPath: path,
          cues: [],
          speakers: [],
          brief: "",
          beats: [],
          sections: [],
          timedBeats: [],
          voiceover: defaultVoiceover(),
        };
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
            brief: "",
            beats: [],
            sections: [],
            timedBeats: [],
            voiceover: defaultVoiceover(),
          };
          notify(`Loaded ${loaded.cues.length} cues from the project sidecar.`);
        } else if (await api.fileExists(derived.srt)) {
          const raw = await api.readTextFile(derived.srt);
          const parsed = parseSrt(raw, { minGap: settings.minGap });
          // Colour-coded files arrive with speakers already grouped; without the
          // merge their cues would hold ids pointing at nothing.
          const merged = mergeImportedSpeakers([], parsed);
          loaded = {
            videoPath: path,
            cues: merged.cues,
            speakers: merged.speakers,
            brief: "",
            beats: [],
            sections: [],
            timedBeats: [],
            voiceover: defaultVoiceover(),
          };
          notify(
            `Imported ${merged.cues.length} cues from ${derived.stem}.srt` +
              (parsed.speakers.length
                ? ` with ${parsed.speakers.length} speaker colours`
                : "") +
              (parsed.warnings.length ? ` (${parsed.warnings.length} warnings).` : "."),
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
        stateCall
          .then((state) => {
            setAppState(state);
            // An adopted sibling project resumes where it was left, exactly as
            // opening it by name would. A bare video has nothing to resume.
            const saved = adopted
              ? state.recentProjects.find((entry) => entry.path === adopted)
              : undefined;
            if (saved && saved.position > 0) setPendingPosition(saved.position);
          })
          .catch(() => undefined);

        if (!info.hasAudio) {
          notify("This file has no audio track, so there is no waveform.", "error");
        }
      } catch (e) {
        notify(errorMessage(e), "error");
      }
    },
    [attachMedia, load, notify, settings.minGap, flushPosition],
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

  /** For panels that need a yes/no before overwriting something. */
  const confirmReplace = useCallback(
    (question: string) =>
      ask(question, {
        title: "Replace",
        kind: "warning",
        okLabel: "Replace",
        cancelLabel: "Cancel",
      }),
    [],
  );

  const openProjectAt = useCallback(
    async (path: string) => {
      // Before attaching new media: loading a source resets the clock to zero,
      // which would otherwise be what the outgoing project remembers.
      flushPosition();
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
        api
          .rememberProject(path, loaded.videoPath)
          .then((state) => {
            setAppState(state);
            // Read the position back from the state that was just written, not
            // from the copy in memory, which is a session behind.
            const saved = state.recentProjects.find((entry) => entry.path === path);
            if (saved && saved.position > 0) setPendingPosition(saved.position);
          })
          .catch(() => undefined);
      } catch (e) {
        // A project that cannot be read is not worth offering again.
        api.forgetProject(path).then(setAppState).catch(() => undefined);
        notify(`Could not open ${path}: ${errorMessage(e)}`, "error");
      }
    },
    [attachMedia, detachMedia, load, notify, flushPosition],
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
    flushPosition(); // Before detachMedia clears the outgoing project's clock.
    detachMedia();
    setProjectPath(null);
    load(emptyProject);
    api.clearLastProject().then(setAppState).catch(() => undefined);
    notify("New project. Open a video to get started.");
  }, [confirmDiscard, detachMedia, load, notify, flushPosition]);

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

  /**
   * A `/continue`, `/story` or `/direct` run's edits: however long it takes,
   * one undo step. A direction run sends only the voicing, so clips a
   * generation run adds meanwhile are kept.
   */
  const applyAgentPatch = useCallback(
    (
      patch: Partial<Pick<Project, "cues" | "sections" | "beats" | "timedBeats">> & {
        voicing?: Record<string, CueVoicing>;
      },
      runId: string,
    ) => {
      update(
        (current) => {
          const { voicing, ...rest } = patch;
          const changed = (Object.keys(rest) as Array<keyof typeof rest>).some(
            (key) => rest[key] !== undefined && rest[key] !== current[key],
          );
          const voiced = voicing !== undefined && voicing !== current.voiceover.voicing;
          if (!changed && !voiced) return current;
          return {
            ...current,
            ...rest,
            ...(voiced ? { voiceover: { ...current.voiceover, voicing } } : {}),
          };
        },
        { mergeKey: `agent:${runId}`, mergeWindowMs: Infinity },
      );
    },
    [update],
  );

  const setBeats = useCallback(
    (next: string[], mergeKey?: string) => {
      update(
        (current) => (next === current.beats ? current : { ...current, beats: next }),
        mergeKey ? { mergeKey } : undefined,
      );
    },
    [update],
  );

  const setBrief = useCallback(
    (brief: string) =>
      update(
        (current) => (brief === current.brief ? current : { ...current, brief }),
        { mergeKey: "brief" },
      ),
    [update],
  );

  // --- Sections -----------------------------------------------------------
  const setSections = useCallback(
    (fn: (list: Section[]) => Section[], mergeKey?: string) => {
      update((current) => {
        const next = fn(current.sections);
        return next === current.sections ? current : { ...current, sections: next };
      }, mergeKey ? { mergeKey } : undefined);
    },
    [update],
  );

  const setTimedBeats = useCallback(
    (fn: (list: TimedBeat[]) => TimedBeat[], mergeKey?: string) => {
      update((current) => {
        const next = fn(current.timedBeats);
        return next === current.timedBeats ? current : { ...current, timedBeats: next };
      }, mergeKey ? { mergeKey } : undefined);
    },
    [update],
  );

  // --- Voiceover ----------------------------------------------------------
  const setVoiceover = useCallback(
    (fn: (voiceover: Voiceover) => Voiceover, mergeKey?: string) => {
      update((current) => {
        const next = fn(current.voiceover);
        return next === current.voiceover ? current : { ...current, voiceover: next };
      }, mergeKey ? { mergeKey } : undefined);
    },
    [update],
  );

  /** The Edit tab's cut. A drag passes a `drag:` key and folds into one undo step. */
  const setEdit = useCallback(
    (fn: (edit: Edit | undefined) => Edit | undefined, mergeKey?: string) => {
      update((current) => {
        const next = fn(current.edit);
        if (next === current.edit) return current;
        if (next === undefined) {
          const { edit: _gone, ...rest } = current;
          return rest;
        }
        return { ...current, edit: next };
      }, mergeKey
        ? { mergeKey, ...(mergeKey.startsWith("drag:") ? { mergeWindowMs: Infinity } : {}) }
        : undefined);
    },
    [update],
  );

  /**
   * A finished bake becomes the project's video, in one undo step with the
   * record of what was baked. The bake it replaces goes to the Recycle Bin,
   * unless the edit still uses that file as a source.
   */
  const adoptBake = useCallback(
    async (path: string, planHash: string) => {
      const previous = project.edit?.baked?.path;
      // Everything timed against the old video moves with the cut, in the same
      // undo step: one undo brings back the old video and the old timing.
      const rebase = (current: Project) => {
        if (!current.edit) return null;
        const oldSegs = previousSegments(current.edit, current.videoPath);
        const newSegs = cutSegments(current.edit);
        return { newSegs, result: oldSegs ? recutProject(current, oldSegs, newSegs, editEnd(current.edit)) : null };
      };
      // The dialog is modal, so the project is the same one the update sees.
      const preview = rebase(project);
      await attachMedia(path);
      update((current) => {
        const step = rebase(current);
        if (!current.edit || !step) return current;
        const moved = step.result?.project ?? current;
        const report = step.result?.report;
        const { recut: _old, ...edit } = current.edit;
        return {
          ...moved,
          videoPath: path,
          edit: {
            ...edit,
            baked: { path, planHash, at: new Date().toISOString(), segments: step.newSegs },
            ...(hasFlags(report) ? { recut: report } : {}),
          },
        };
      });
      const report = preview?.result?.report;
      const timed =
        project.cues.length + project.voiceover.clips.length + project.sections.length + project.timedBeats.length;
      notify(
        report && timed > 0
          ? `Baked ${path}. ${describeRecut(report)}.${hasFlags(report) ? " See Re-cut in the Edit tab." : ""}`
          : `Baked ${path}. Subtitles and Voiceover now work on it.`,
      );
      const inUse = project.edit?.sources.some((s) => s.path === previous);
      if (previous && previous !== path && !inUse) {
        api.trashBake(previous).catch((e) => notify(errorMessage(e), "error"));
      }
    },
    [project, attachMedia, update, notify],
  );

  /** Shows a re-cut item where it lives: a cue, section or beat in Subtitles, a clip in Voiceover. */
  const revealTimed = useCallback(
    (ref: RecutRef) => {
      seek(ref.at);
      if (ref.kind === "clip") {
        setWorkspace("voiceover");
        selectVo({ items: [{ kind: "clip", id: ref.id }], mode: "replace" });
        return;
      }
      setWorkspace("subtitles");
      if (ref.kind === "cue") selectOnly(ref.id);
      if (ref.kind === "section") setSelectedSectionId(ref.id);
    },
    [seek, selectVo, selectOnly],
  );

  /** Deletes everything the last re-cut parked, in one undo step. */
  const deleteLost = useCallback(() => {
    update((current) => {
      const lost = current.edit?.recut?.lost;
      if (!current.edit || !lost || lost.length === 0) return current;
      const gone = (kind: RecutKind, id: string, start: number) =>
        recutFlag(current.edit!.recut, kind, id, start) === "lost";
      const recut = { ...current.edit.recut!, lost: [] };
      return {
        ...current,
        cues: current.cues.filter((c) => !gone("cue", c.id, c.start)),
        sections: current.sections.filter((x) => !gone("section", x.id, x.start)),
        timedBeats: current.timedBeats.filter((b) => !gone("beat", b.id, b.time)),
        voiceover: {
          ...current.voiceover,
          clips: current.voiceover.clips.filter((c) => !gone("clip", c.id, c.start)),
        },
        edit: hasFlags(recut) ? { ...current.edit, recut } : withoutRecut(current.edit),
      };
    });
  }, [update]);

  // The panes follow `videoPath` when undo or redo moves it — across a bake,
  // say. Opening a file attaches it directly; a missing file is left to the
  // message that reported it.
  useEffect(() => {
    const path = project.videoPath;
    if (!path || path === attachedPath.current) return;
    let cancelled = false;
    void api.fileExists(path).then(async (exists) => {
      if (cancelled || !exists || path === attachedPath.current) return;
      try {
        await attachMedia(path);
      } catch (e) {
        notify(errorMessage(e), "error");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [project.videoPath, attachMedia, notify]);

  // The Edit tab has its own clock; the Subtitles player stops while it shows.
  useEffect(() => {
    if (editMode) videoRef.current?.pause();
  }, [editMode]);

  /**
   * A timeline drag is one undo step however long it is held: its key is unique
   * to the gesture, so it can merge without a time limit.
   */
  const dragVoiceover = useCallback(
    (fn: (voiceover: Voiceover) => Voiceover, drag: string) => {
      update((current) => {
        const next = fn(current.voiceover);
        return next === current.voiceover ? current : { ...current, voiceover: next };
      }, { mergeKey: `drag:${drag}`, mergeWindowMs: Infinity });
    },
    [update],
  );

  const patchTrackById = useCallback(
    (id: string, patch: TrackPatch) =>
      // Typing a name or sweeping a fader is one step, not one per change.
      setVoiceover((v) => patchTrack(v, id, patch), `track:${id}:${Object.keys(patch).join()}`),
    [setVoiceover],
  );

  const patchClipById = useCallback(
    (id: string, patch: ClipPatch) =>
      setVoiceover((v) => patchClip(v, id, patch), `clip:${id}:${Object.keys(patch).join()}`),
    [setVoiceover],
  );

  const removeClipById = useCallback(
    (id: string) => setVoiceover((v) => removeClip(v, id)),
    [setVoiceover],
  );

  /** Places the chosen files end to end on a track, starting at the playhead. */
  const importAudio = useCallback(
    async (trackId: string) => {
      if (!mixer) return;
      const picked = await openDialog({
        multiple: true,
        filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
      });
      const files = typeof picked === "string" ? [picked] : picked ?? [];
      if (files.length === 0) return;

      const clips: VoiceClip[] = [];
      let at = currentTimeRef.current;
      for (const file of files) {
        try {
          const buffer = await mixer.load(file);
          const clip = newClip(trackId, file, at, buffer.duration);
          clips.push(clip);
          at += clip.duration;
        } catch (e) {
          notify(`Could not read ${file}: ${errorMessage(e)}`, "error");
        }
      }
      if (clips.length === 0) return;
      setVoiceover((v) => addClips(v, clips));
      selectVo({ items: [{ kind: "clip", id: clips[clips.length - 1].id }], mode: "replace" });
    },
    [mixer, notify, setVoiceover, selectVo],
  );

  // --- Voices -------------------------------------------------------------
  const voices = useVoiceGeneration({
    voiceover: project.voiceover,
    cues,
    paths,
    // A whole run is one undo step, however long it takes.
    commit: dragVoiceover,
    notify,
  });
  const [showTtsInstall, setShowTtsInstall] = useState(false);

  const referenceFromFile = useCallback(
    async (key: string) => {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
      });
      if (typeof picked === "string") setVoiceover((v) => setVoice(v, key, { reference: picked }));
    },
    [setVoiceover],
  );

  /** The speaker whose reference cues are being chosen, while the picker is open. */
  const [referenceKey, setReferenceKey] = useState<string | null>(null);

  /**
   * Plays one cue's stretch of the video, for judging it as a reference. The
   * mix is bypassed meanwhile (see the mixer effect): the duck would bury the
   * very voice being listened for, and generated clips would talk over it.
   */
  const stopPreviewRef = useRef<(() => void) | null>(null);
  const stopPreview = useCallback(() => {
    stopPreviewRef.current?.();
  }, []);
  const previewCue = useCallback(
    (cue: Cue) => {
      stopPreviewRef.current?.();
      const video = videoRef.current;
      if (!video) return;
      let frame = 0;
      const stop = () => {
        cancelAnimationFrame(frame);
        video.removeEventListener("pause", stop);
        stopPreviewRef.current = null;
        setPreviewCueId(null);
        if (!video.paused) video.pause();
      };
      // Polled per frame rather than on `timeupdate`, which fires only a few
      // times a second and would let the next line bleed in.
      const watch = () => {
        if (video.currentTime >= cue.end) stop();
        else frame = requestAnimationFrame(watch);
      };
      seek(cue.start);
      video.addEventListener("pause", stop);
      stopPreviewRef.current = stop;
      setPreviewCueId(cue.id);
      void video.play().then(() => {
        frame = requestAnimationFrame(watch);
      }, stop);
    },
    [seek],
  );

  /** Clones a speaker's voice from the cues chosen in the reference picker. */
  const buildReference = useCallback(
    async (key: string, chosen: Cue[]) => {
      if (!paths || !project.videoPath) return;
      const segments = referenceSegments(chosen);
      const out = referencePath(paths.dir, paths.stem, key);
      const built = await api.ttsExtractReference(project.videoPath, segments, out);
      setVoiceover((v) =>
        setVoice(v, key, { reference: out, referenceCueIds: chosen.map((c) => c.id) }),
      );
      const from =
        built.kept < built.lines
          ? `${built.kept} of ${built.lines} lines`
          : `${built.lines} line${built.lines === 1 ? "" : "s"}`;
      notify(
        `Cloning the voice from ${from} (${built.seconds.toFixed(1)} s of ` +
          `${built.isolated ? "clean speech" : "the film's sound"}).`,
      );
    },
    [paths, project.videoPath, setVoiceover, notify],
  );

  /** Lines, their cues and their state: worked out once per change. */
  const lines = useMemo(() => lineIndex(project.voiceover, cues), [project.voiceover, cues]);

  /** Boundaries between cues spoken as one line: from one cue's end to the next one's start. */
  const lineJoins = useMemo(
    () =>
      lines.groups.flatMap((group) =>
        group.slice(1).map((cue, i): [number, number] => [group[i].end, cue.start]),
      ),
    [lines],
  );

  /** Clips whose line changed, which play over each other, or which run past their cue. */
  const clipWarnings = useMemo(() => {
    const warnings = new Map<string, ClipWarning>();
    const overlapping = overlappingClips(project.voiceover);
    for (const clip of project.voiceover.clips) {
      if (lines.isStale(clip)) warnings.set(clip.id, "stale");
      else if (overlapping.has(clip.id)) warnings.set(clip.id, "overlap");
      else if (overrun(clip, cues) > 0) warnings.set(clip.id, "overrun");
    }
    return warnings;
  }, [project.voiceover, lines, cues]);

  /** The first cue of the selected clip's line. */
  const selectedCueOfClip = useMemo(
    () =>
      selectedClip?.source
        ? cues.find((c) => c.id === selectedClip.source!.cueIds[0]) ?? null
        : null,
    [selectedClip, cues],
  );

  // --- Voice lines --------------------------------------------------------
  /**
   * The cue whose voice line is open in the editor: the selected cue, or the
   * first cue of the selected clip's line.
   */
  const editedCue = useMemo(() => {
    const primary = voSel.primary;
    if (primary?.kind === "cue") return cues.find((c) => c.id === primary.id) ?? null;
    return selectedCueOfClip;
  }, [voSel.primary, cues, selectedCueOfClip]);

  const editCueLine = useCallback(
    (cueId: string) => {
      selectVo({ items: [{ kind: "cue", id: cueId }], mode: "replace" });
      setVoTab("line");
    },
    [selectVo],
  );

  const selectClip = useCallback(
    (id: string) => {
      selectVo({ items: [{ kind: "clip", id }], mode: "replace" });
      setVoTab("clip");
    },
    [selectVo],
  );

  /**
   * D: one press ducks every selected cue, or — when they all are already —
   * lets the original through under all of them.
   */
  const toggleDuckOnSelection = useCallback(() => {
    const ids = [...voSel.cues];
    if (ids.length === 0) return;
    setVoiceover((v) => {
      const allDucked = ids.every((id) => !v.unduckedCueIds.includes(id));
      const others = v.unduckedCueIds.filter((id) => !ids.includes(id));
      return { ...v, unduckedCueIds: allDucked ? [...others, ...ids] : others };
    });
  }, [voSel.cues, setVoiceover]);

  /**
   * Remembers where everything stood when a selection drag began: each event
   * moves the selection by the whole distance dragged, from there.
   */
  const selectionDragOrigin = useRef<{ key: string; cues: Cue[]; voiceover: Voiceover } | null>(
    null,
  );

  /**
   * Moves every selected cue and clip by the same amount: one block, one undo
   * step. Clips stop at zero and cues at their unselected neighbours, and
   * whichever stops first stops both, so the selection never comes apart.
   */
  const moveSelection = useCallback(
    (delta: number, drag: string) => {
      update(
        (current) => {
          if (selectionDragOrigin.current?.key !== drag) {
            selectionDragOrigin.current = {
              key: drag,
              cues: current.cues,
              voiceover: current.voiceover,
            };
          }
          const origin = selectionDragOrigin.current;
          const clips = moveClipsBy(origin.voiceover, voSel.clips, delta);
          let applied = voSel.clips.size > 0 ? clips.delta : delta;
          let movedCues = origin.cues;
          if (voSel.cues.size > 0) {
            movedCues = moveCuesBy(origin.cues, voSel.cues, applied, duration, settings.minGap);
            const probe = origin.cues.find((c) => voSel.cues.has(c.id));
            const after = probe && movedCues.find((c) => c.id === probe.id);
            if (probe && after) applied = after.start - probe.start;
          }
          const voiceover =
            voSel.clips.size > 0
              ? moveClipsBy(origin.voiceover, voSel.clips, applied).voiceover
              : origin.voiceover;
          return { ...current, cues: movedCues, voiceover };
        },
        { mergeKey: `selection:${drag}`, mergeWindowMs: Infinity },
      );
    },
    [update, voSel.cues, voSel.clips, duration, settings.minGap],
  );

  const suggestLine = useCallback(
    async (cue: Cue) => {
      const index = cues.findIndex((c) => c.id === cue.id);
      const speakerOf = (c: Cue) => speakers.find((s) => s.id === c.speakerId);
      const context = (list: Cue[]) =>
        list.map((c) => ({ speaker: speakerOf(c)?.name ?? "Unknown", text: speechText(c) }));
      const voicing = project.voiceover.voicing[cue.id] ?? {};
      return api.aiDirectLine({
        model: settings.model,
        speaker: speakerOf(cue)?.name ?? "",
        voiceNotes: speakerOf(cue)?.voiceNotes ?? "",
        text: speechText(cue),
        spoken: voicing.spoken ?? "",
        direction: voicing.direction ?? "",
        engine: renderLine(project.voiceover, cue).voice.engine,
        before: context(cues.slice(Math.max(0, index - 4), index)),
        after: context(cues.slice(index + 1, index + 3)),
      });
    },
    [cues, speakers, project.voiceover, settings.model],
  );

  /**
   * A cue dragged on the Voiceover timeline. The same neighbour rules as the
   * waveform, but always the one cue — the Voiceover tab has no cue selection
   * — and one undo step for the whole drag, however long it is held.
   */
  const retimeCueInVoiceover = useCallback(
    (id: string, start: number, end: number, kind: "move" | "resize", drag: string) =>
      update(
        (current) => {
          const next =
            kind === "resize"
              ? resizeCue(current.cues, id, start, end, duration, settings.minGap)
              : moveCueTo(current.cues, id, start, duration, settings.minGap);
          return next === current.cues ? current : { ...current, cues: next };
        },
        { mergeKey: `cuedrag:${drag}`, mergeWindowMs: Infinity },
      ),
    [update, duration, settings.minGap],
  );

  const fitCues = useCallback(
    (ids?: Set<string>) =>
      setCues((list) =>
        fitCuesToLines(list, project.voiceover, duration, settings.minGap, ids),
      ),
    [setCues, project.voiceover, duration, settings.minGap],
  );

  /**
   * Speeds up overrunning lines so each ends with its last cue, as a new take
   * on its clip; the take as spoken stays, to switch back to. Clips that do
   * not overrun, or would need too much, are left alone. One undo step.
   */
  const speedUpClips = useCallback(
    async (clipIds: string[]) => {
      const batch = `stretch:${makeId()}`;
      let done = 0;
      try {
        for (const id of clipIds) {
          const clip = project.voiceover.clips.find((c) => c.id === id);
          const take = clip && currentTake(clip);
          const ratio = clip && fitRatio(clip, cues);
          if (!clip || !take || !ratio) continue;
          const original = take.original ?? take.file;
          const file = stretchPath(original, ratio);
          const seconds = await api.ttsStretch(original, file, ratio);
          dragVoiceover((v) => addTake(v, id, stretchedTake(take, ratio, file, seconds)), batch);
          done += 1;
        }
        if (clipIds.length > 1) notify(`Sped up ${done} line${done === 1 ? "" : "s"} to fit.`);
      } catch (e) {
        notify(errorMessage(e), "error");
      }
    },
    [project.voiceover.clips, cues, dragVoiceover, notify],
  );

  /**
   * Offers the voice files nothing uses any more for the Recycle Bin: not the
   * project, not a step it can undo or redo to, not the file it was saved as.
   */
  const cleanUpVoiceFiles = useCallback(async () => {
    if (!paths) return;
    const dir = voiceoverDir(paths.dir, paths.stem);
    try {
      const keep = voiceFilesInUse(versions().map((p) => p.voiceover));
      const unused = await api.voiceoverUnusedFiles(dir, keep);
      if (unused.length === 0) {
        notify("Every voice file is still in use.");
        return;
      }
      const bytes = unused.reduce((n, f) => n + f.bytes, 0);
      const files = `${unused.length} voice file${unused.length === 1 ? "" : "s"}`;
      const ok = await ask(
        `Move ${files} (${formatBytes(bytes)}) to the Recycle Bin? Nothing in this project uses them — ` +
          "not a clip, a take, a reference, a step you can undo to, or the saved file.",
        {
          title: "Clean up voice files",
          kind: "warning",
          okLabel: "Move to Recycle Bin",
          cancelLabel: "Cancel",
        },
      );
      if (!ok) return;
      const freed = await api.voiceoverTrashFiles(
        dir,
        unused.map((f) => f.path),
      );
      notify(`Moved ${files} (${formatBytes(freed)}) to the Recycle Bin.`);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }, [paths, versions, notify]);

  /** Every generated clip that overruns and can be sped up to fit. */
  const fittableClipIds = useMemo(
    () => project.voiceover.clips.filter((c) => fitRatio(c, cues) !== null).map((c) => c.id),
    [project.voiceover.clips, cues],
  );

  /** Right-click on a cue in the Voiceover tab: its voice line and its duck. */
  const openVoiceCueMenu = useCallback(
    (cueId: string, x: number, y: number) => {
      const cue = cues.find((c) => c.id === cueId);
      if (!cue) return;
      const clip = clipForCue(project.voiceover, cue.id);
      const installed = voices.status?.installed ?? false;
      const silent = !hasSomethingToSay(project.voiceover, cue);
      const why = silent
        ? "The cue has no text"
        : !paths
          ? "Open a video first"
          : undefined;
      const group = lines.groupOf(cue.id) ?? [cue];
      const size = group.length > 1 ? ` (${group.length} cues)` : "";

      // The boundary after this cue: what joining or splitting it would do.
      const speakable = cues.filter((c) => hasSomethingToSay(project.voiceover, c));
      const next = speakable[speakable.findIndex((c) => c.id === cue.id) + 1];
      const joined = next !== undefined && group.some((c) => c.id === next.id);
      const joinable =
        next !== undefined &&
        !joined &&
        lineIndex(setJoin(project.voiceover, cue.id, "join"), cues)
          .groupOf(cue.id)
          ?.some((c) => c.id === next.id) === true;
      const joinWhy =
        next === undefined
          ? "It is the last line"
          : next.speakerId !== cue.speakerId || (next.mode ?? "") !== (cue.mode ?? "")
            ? "The next cue is another speaker or mode"
            : "Together they are too long for one line";

      setContextMenu({
        x,
        y,
        entries: [
          installed
            ? {
                kind: "item",
                label: (clip ? "Generate new take" : "Generate voice line") + size,
                detail: why,
                disabled: why !== undefined,
                onSelect: () => void voices.generate([cue]),
              }
            : {
                kind: "item",
                label: "Install voice engine…",
                detail: "Needed to generate voice lines",
                onSelect: () => setShowTtsInstall(true),
              },
          {
            kind: "item",
            label: "Edit voice line…",
            detail: "Spoken text, tags and direction",
            onSelect: () => editCueLine(cue.id),
          },
          {
            kind: "item",
            label: "Select its clip",
            disabled: !clip,
            onSelect: () => clip && selectClip(clip.id),
          },
          { kind: "separator" },
          joined
            ? {
                kind: "item",
                label: "Speak separately from the next cue",
                detail: "Splits the line here",
                onSelect: () => setVoiceover((v) => setJoin(v, cue.id, "split")),
              }
            : {
                kind: "item",
                label: "Speak together with the next cue",
                detail: joinable ? "One line, so the sentence flows" : joinWhy,
                disabled: !joinable,
                onSelect: () => setVoiceover((v) => setJoin(v, cue.id, "join")),
              },
          {
            kind: "item",
            label: "Group automatically here",
            detail: "Forget the choice made for this boundary",
            disabled: project.voiceover.joins[cue.id] === undefined,
            onSelect: () => setVoiceover((v) => setJoin(v, cue.id, undefined)),
          },
          { kind: "separator" },
          {
            kind: "item",
            label: "Fit cue to its voice line",
            detail: clip ? undefined : "It has no line yet",
            disabled: !clip,
            onSelect: () => fitCues(new Set([cue.id])),
          },
          {
            kind: "item",
            label: "Fit all cues to their lines",
            disabled: project.voiceover.clips.every((c) => !c.source),
            onSelect: () => fitCues(),
          },
          {
            kind: "item",
            label: "Speed up its line to fit",
            detail: !clip
              ? "It has no line yet"
              : overrun(clip, cues) === 0
                ? "It already fits"
                : fitRatio(clip, cues) === null
                  ? `Needs more than ${MAX_STRETCH}× — try a new take`
                  : `${fitRatio(clip, cues)!.toFixed(2)}×, as a new take`,
            disabled: !clip || fitRatio(clip, cues) === null,
            onSelect: () => clip && void speedUpClips([clip.id]),
          },
          {
            kind: "item",
            label: "Speed up every overrunning line",
            detail: fittableClipIds.length ? `${fittableClipIds.length} lines` : undefined,
            disabled: fittableClipIds.length === 0,
            onSelect: () => void speedUpClips(fittableClipIds),
          },
          { kind: "separator" },
          {
            kind: "item",
            label: "Duck under this cue",
            checked: !project.voiceover.unduckedCueIds.includes(cue.id),
            onSelect: () => setVoiceover((v) => toggleCueDuck(v, cue.id)),
          },
        ],
      });
    },
    [
      cues,
      project.voiceover,
      lines,
      voices,
      paths,
      setVoiceover,
      fitCues,
      editCueLine,
      selectClip,
      speedUpClips,
      fittableClipIds,
    ],
  );

  /** Text for the chat box, set from elsewhere — the Story panel's ✦ Story. */
  const [chatPrefill, setChatPrefill] = useState<{ text: string; nonce: number } | null>(null);

  /**
   * Flags an instant and puts the new section straight into rename, so the whole
   * gesture is one key press and then typing.
   */
  const addSectionAt = useCallback(
    (time: number) => {
      // A flag needs a timeline to sit on; with no media every one would pile
      // up at zero.
      if (duration <= 0) return;
      const section = newSection(sections, time);
      setSections((list) => insertSection(list, section, duration));
      setSelectedSectionId(section.id);
      setRenamingSectionId(section.id);
    },
    [setSections, sections, duration],
  );

  const addSectionAtPlayhead = useCallback(
    () => addSectionAt(currentTime),
    [addSectionAt, currentTime],
  );

  const renameSectionById = useCallback(
    (id: string, label: string) =>
      setSections((list) => renameSection(list, id, label), `section-name:${id}`),
    [setSections],
  );

  const noteSectionById = useCallback(
    (id: string, note: string) =>
      setSections((list) => setSectionNote(list, id, note), `section-note:${id}`),
    [setSections],
  );

  /** One undo step for the whole drag; the lane commits only on release. */
  const moveSectionTo = useCallback(
    (id: string, start: number) =>
      setSections((list) => moveSection(list, id, start, duration), `section:${id}`),
    [setSections, duration],
  );

  const removeSectionById = useCallback(
    (id: string) => {
      setSections((list) => removeSection(list, id));
      setSelectedSectionId((current) => (current === id ? null : current));
    },
    [setSections],
  );

  const jumpToSection = useCallback(
    (direction: number) => {
      const target =
        direction < 0
          ? previousSection(sections, currentTime)
          : nextSection(sections, currentTime);
      if (!target) return;
      setSelectedSectionId(target.id);
      seek(target.start);
    },
    [sections, currentTime, seek],
  );

  const jumpToSectionId = useCallback(
    (id: string) => {
      const target = sections.find((s) => s.id === id);
      if (!target) return;
      setSelectedSectionId(id);
      seek(target.start);
    },
    [sections, seek],
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

  const toggleThought = useCallback(
    (cueId: string) =>
      setCues((list) =>
        list.map((c) => {
          if (c.id !== cueId) return c;
          if (c.mode !== "thought") return { ...c, mode: "thought" as const };
          const { mode: _mode, ...rest } = c;
          return rest;
        }),
      ),
    [setCues],
  );

  /**
   * Flip the selection between spoken and thought, as one undo step. Mixed
   * selections become all thought, so a second press is what clears them —
   * the toggle never leaves the selection half one and half the other.
   */
  const toggleThoughtOnSelection = useCallback(() => {
    if (selectedIds.size === 0) return;
    const selected = cues.filter((c) => selectedIds.has(c.id));
    const allThought = selected.every((c) => c.mode === "thought");
    setCues((list) =>
      list.map((c) => {
        if (!selectedIds.has(c.id)) return c;
        if (allThought) {
          const { mode: _mode, ...rest } = c;
          return rest;
        }
        return { ...c, mode: "thought" as const };
      }),
    );
  }, [cues, selectedIds, setCues]);

  /**
   * Drop a cue into the timeline and leave it selected, so the speaker keys
   * act on it straight away. Placement is decided here rather than inside the
   * updater: React may not run that until the next render, and the caller
   * needs to know now whether the cue found room.
   */
  const placeCue = useCallback(
    (cue: Cue) => {
      const next = insertCueClamped(cues, cue, duration, minGap);
      if (!next) {
        notify("There is no room for a cue there.", "error");
        return;
      }
      setCues(() => next);
      selectOnly(cue.id);
    },
    [cues, setCues, duration, minGap, selectOnly, notify],
  );

  // A new cue carries on from the selected one — same speaker, same mode — so a
  // run of thoughts stays a run of thoughts.
  const createCue = useCallback(
    (start: number, end: number) =>
      placeCue(newCue(start, end, selectedCue?.speakerId ?? null, selectedCue?.mode)),
    [placeCue, selectedCue],
  );

  const fitSelectionToReadingSpeed = useCallback(() => {
    if (selectedIds.size === 0) return;

    const next = fitCuesToReadingSpeed(
      cues,
      selectedIds,
      settings.targetCps,
      duration,
      minGap,
    );
    if (next === cues) {
      notify("Nothing to retime — the cues already fit.", "error");
      return;
    }
    setCues(() => next);
  }, [cues, selectedIds, setCues, settings.targetCps, duration, minGap, notify]);

  /**
   * Clipboard text becomes a cue at the playhead: re-flowed to the line limits
   * and timed to the target reading speed, so it needs no further tidying.
   */
  const pasteCueAtPlayhead = useCallback(
    (raw: string) => {
      const text = wrapText(raw, settings.maxCharsPerLine, settings.maxLines);
      if (text === "") return;

      const start = currentTime;
      const limit = duration > 0 ? duration : Number.MAX_SAFE_INTEGER;
      const end = Math.min(start + durationForText(text, settings.targetCps), limit);
      placeCue({
        ...newCue(start, end, selectedCue?.speakerId ?? null, selectedCue?.mode),
        text,
      });
    },
    [
      placeCue,
      selectedCue,
      currentTime,
      duration,
      settings.maxCharsPerLine,
      settings.maxLines,
      settings.targetCps,
    ],
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

  /**
   * Replace the cue list with the contents of an SRT. Shared by Import .srt and
   * by the transcriber, so both land cues on identical terms.
   */
  const applyImportedSrt = useCallback(
    (raw: string, verb: "Imported" | "Transcribed") => {
      const { cues: parsed, speakers: imported, split, warnings } = parseSrt(raw, {
        minGap: settings.minGap,
      });
      if (parsed.length === 0) {
        // The engine exits cleanly with an empty .srt when it hears no speech,
        // so blaming "that file" would be wrong on the transcription path.
        return notify(
          verb === "Transcribed"
            ? "The transcription produced no cues — no speech was detected in the audio."
            : "No cues could be read from that file.",
          "error",
        );
      }
      // Speakers merge rather than replace, so a file whose colours are already
      // known lands on the speakers the user has named. Transcriptions declare
      // no colours, which makes this a no-op on that path.
      update((current) => {
        const merged = mergeImportedSpeakers(current.speakers, {
          cues: parsed,
          speakers: imported,
          split,
          warnings,
        });
        return { ...current, cues: merged.cues, speakers: merged.speakers };
      });
      selectOnly(parsed[0].id);

      // Other tools happily emit overlapping cues; say so rather than leaving
      // the editor in a state its own rules forbid.
      const overlapping = findOverlaps(parsed, settings.minGap).length;
      notify(
        `${verb} ${parsed.length} cues` +
          (warnings.length ? `; ${warnings.length} lines needed repair.` : ".") +
          (imported.length > 0
            ? ` ${imported.length} speaker ${imported.length === 1 ? "colour" : "colours"} recognised.`
            : "") +
          (split > 0
            ? ` ${split} ${split === 1 ? "block held" : "blocks held"} two speakers and ${split === 1 ? "was" : "were"} split.`
            : "") +
          (overlapping > 0
            ? ` ${overlapping} overlap — use Edit ▸ Fix overlapping cues.`
            : ""),
      );
    },
    [update, notify, selectOnly, settings.minGap],
  );

  const importSrtFrom = useCallback(
    async (path: string) => {
      try {
        applyImportedSrt(await api.readTextFile(path), "Imported");
      } catch (e) {
        notify(errorMessage(e), "error");
      }
    },
    [applyImportedSrt, notify],
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
      // In the Edit tab, videos and images are sources for the cut.
      if (editMode) {
        const editIntent = classifyEditDrop(paths);
        if (editIntent.kind === "media") {
          return editRef.current?.addFiles([...editIntent.videos, ...editIntent.images]);
        }
        if (editIntent.kind === "none") {
          return notify("Drop videos or images to add them to the edit.", "error");
        }
      }
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
    [confirmDiscard, openProjectAt, openVideoAt, importSrtFrom, project.videoPath, notify, editMode],
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
      await api.writeTextFile(
        target,
        serializeSrt(cues, { speakers, speakerColors: settings.srtSpeakerColors }),
      );
      notify(`Exported ${cues.length} cues to .srt`);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }, [cues, speakers, settings.srtSpeakerColors, paths, notify]);

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

  // --- Fill ---------------------------------------------------------------
  /** For preferences a dialog changes in passing, saved as they change. */
  const patchSettings = useCallback(
    (patch: Partial<Settings>) => {
      const next = { ...settings, ...patch };
      setSettings(next);
      api.saveSettings(next).catch((e) => notify(errorMessage(e), "error"));
    },
    [settings, notify],
  );

  // --- Autocomplete -------------------------------------------------------
  const toggleGhost = useCallback(() => {
    const on = !settings.ghostEnabled;
    patchSettings({ ghostEnabled: on });
    notify(
      on
        ? apiKeySet
          ? "Cue autocomplete on."
          : "Cue autocomplete on — add an OpenRouter key in Settings to use it."
        : "Cue autocomplete off.",
    );
  }, [settings.ghostEnabled, apiKeySet, patchSettings, notify]);

  const ghost = useGhostCompletion({
    cues,
    speakers,
    settings,
    apiKeySet,
    onToggle: toggleGhost,
    onError: (message) => notify(message, "error"),
  });

  /**
   * Opens on the selection. A selection holding an empty cue is there to be
   * filled; anything else most likely wants the story carried on after it.
   */
  const openFill = useCallback(() => {
    const selected = cues.filter((c) => selectedIds.has(c.id));
    const last = selected[selected.length - 1];
    setFillOpen({
      selectedCueIds: selected.map((c) => c.id),
      continueAfter: last ? last.end : currentTime,
      initialKind: selected.some((c) => c.text.trim() === "") ? "fill" : "continue",
    });
  }, [cues, selectedIds, currentTime]);

  /** Lands a fill as one undo step. False when new lines had no room. */
  const acceptFill = useCallback(
    (result: AcceptedFill): boolean => {
      const shape = (text: string) =>
        wrapText(text, settings.maxCharsPerLine, settings.maxLines);
      const voiced = (cue: Cue, mode: "spoken" | "thought"): Cue => {
        if (mode === "thought") return { ...cue, mode: "thought" };
        const { mode: _mode, ...spoken } = cue;
        return spoken;
      };

      if (result.kind === "fill") {
        if (result.lines.length === 0) return false;
        const byId = new Map(result.lines.map((line) => [line.cueId, line]));
        setCues((list) =>
          list.map((cue) => {
            const line = byId.get(cue.id);
            if (!line) return cue;
            return voiced({ ...cue, text: shape(line.text), speakerId: line.speakerId }, line.mode);
          }),
        );
        const count = result.lines.length;
        notify(`Filled ${count} cue${count === 1 ? "" : "s"}.`);
        return true;
      }

      const texts = result.lines.map((line) => shape(line.text));
      const timing = layoutContinuation(texts, result.window, settings.targetCps, minGap);
      if (!timing || texts.length === 0) {
        notify("There is not enough room for those lines before the next cue.", "error");
        return false;
      }
      const created = result.lines.map((line, i) =>
        voiced(
          {
            id: makeId(),
            start: timing[i].start,
            end: timing[i].end,
            text: texts[i],
            speakerId: line.speakerId,
          },
          line.mode,
        ),
      );
      setCues((list) => sortCues([...list, ...created]));
      // The last one, so pressing Ctrl+G again carries on from where these end.
      selectOnly(created[created.length - 1].id);
      notify(
        `Added ${created.length} line${created.length === 1 ? "" : "s"}, timed to reading speed.`,
      );
      return true;
    },
    [settings.maxCharsPerLine, settings.maxLines, settings.targetCps, minGap, setCues, selectOnly, notify],
  );

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
      if (!(await confirmDiscard())) return;
      // Nothing unmounts on destroy(), so the timer never gets a last tick.
      flushPosition();
      await getCurrentWindow().destroy();
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [confirmDiscard, flushPosition]);

  // --- Shortcuts ----------------------------------------------------------
  const modalOpen =
    showSettings ||
    showHelp ||
    showRender ||
    showExportAudio ||
    showTtsInstall ||
    showProofread ||
    showTranscribe ||
    fillOpen !== null;

  const subtitleShortcuts: ShortcutActions = {
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
      fitReadingSpeed: fitSelectionToReadingSpeed,
      toggleThought: toggleThoughtOnSelection,
      addSectionAtPlayhead,
      jumpSection: jumpToSection,
      duplicateSelected,
      deleteSelected,
      selectAll,
      clearSelection: () => {
        // Escape backs out of whatever is in the way, innermost first.
        if (contextMenu) setContextMenu(null);
        else if (find) setFind(null);
        else if (selectedSectionId) setSelectedSectionId(null);
        else clearSelection();
      },
      openFind: () =>
        setFind((current) => current ?? { query: "", replacement: "", matchCase: false }),
      openFill,
      save: () => void saveProject(),
      saveAs: () => void saveProjectAs(),
      newProject: () => void newProject(),
      openProject: () => void openProject(),
      undo,
      redo,
      zoom: zoomBy,
      toggleFollow: () => setFollow((f) => !f),
      toggleGhost,
      toggleDuck: () => undefined,
      showHelp: () => setShowHelp(true),
  };

  /**
   * Cues are read-only in the Voiceover tab, so every key that edits them does
   * nothing there; Delete and Escape act on the selected clip instead.
   */
  const voiceoverShortcuts: ShortcutActions = {
    ...subtitleShortcuts,
    assignSpeakerIndex: () => undefined,
    clearSpeaker: () => undefined,
    splitAtPlayhead: () => undefined,
    mergeWithNext: () => undefined,
    nudge: () => undefined,
    selectPrevious: () => undefined,
    selectNext: () => undefined,
    jumpToSelected: () => undefined,
    newCueAtPlayhead: () => undefined,
    fitReadingSpeed: () => undefined,
    toggleThought: () => undefined,
    addSectionAtPlayhead: () => undefined,
    duplicateSelected: () => undefined,
    // Cues cannot be deleted here, so Delete takes only the selected clips.
    deleteSelected: () => {
      if (voSel.clips.size === 0) return;
      const ids = voSel.clips;
      setVoiceover((v) => ({ ...v, clips: v.clips.filter((c) => !ids.has(c.id)) }));
    },
    selectAll: () =>
      selectVo({
        items: project.voiceover.clips.map((c) => ({ kind: "clip" as const, id: c.id })),
        mode: "replace",
      }),
    clearSelection: () => {
      if (contextMenu) setContextMenu(null);
      else setVoSel(EMPTY_SELECTION);
    },
    openFind: () => undefined,
    openFill: () => undefined,
    toggleGhost: () => undefined,
    toggleDuck: toggleDuckOnSelection,
  };

  /**
   * The Edit tab has its own clock and selection: play, split, delete and the
   * arrows act on the cut. Keys that edit cues do nothing there.
   */
  const editShortcuts: ShortcutActions = {
    ...voiceoverShortcuts,
    togglePlay: () => editRef.current?.togglePlay(),
    splitAtPlayhead: () => editRef.current?.split(),
    deleteSelected: () => editRef.current?.deleteSelected(),
    nudge: (_edge, direction) => editRef.current?.nudge(direction),
    zoom: (direction) => editRef.current?.zoom(direction),
    selectAll: () => undefined,
    jumpSection: () => undefined,
    toggleFollow: () => undefined,
    toggleDuck: () => undefined,
    clearSelection: () => {
      if (contextMenu) setContextMenu(null);
      else editRef.current?.clearSelection();
    },
  };

  useShortcuts(
    editMode ? editShortcuts : voiceoverMode ? voiceoverShortcuts : subtitleShortcuts,
    !modalOpen && !menuOpen && !contextMenu,
  );

  usePasteText(
    pasteCueAtPlayhead,
    !voiceoverMode && !editMode && !modalOpen && !menuOpen && !contextMenu,
  );

  // --- Context menu -------------------------------------------------------
  /** Right-clicking a flag on the timeline lane. */
  const openSectionContextMenu = useCallback(
    (id: string, x: number, y: number) => {
      const section = sections.find((s) => s.id === id);
      if (!section) return;
      setSelectedSectionId(id);
      setContextMenu({
        x,
        y,
        entries: [
          {
            kind: "item",
            label: "Rename",
            detail: section.label || undefined,
            onSelect: () => setRenamingSectionId(id),
          },
          {
            kind: "item",
            label: "Move to playhead",
            onSelect: () => moveSectionTo(id, currentTime),
          },
          { kind: "separator" },
          {
            kind: "item",
            label: "Delete section",
            onSelect: () => removeSectionById(id),
          },
        ],
      });
    },
    [sections, currentTime, moveSectionTo, removeSectionById],
  );

  /** Right-clicking the empty part of the lane, which offers only an add. */
  const openLaneContextMenu = useCallback(
    (time: number, x: number, y: number) => {
      setContextMenu({
        x,
        y,
        entries: [
          {
            kind: "item",
            label: "Add section here",
            detail: formatShort(time),
            onSelect: () => addSectionAt(time),
          },
        ],
      });
    },
    [addSectionAt],
  );


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
        {
          kind: "item",
          label: many ? `Thinking${suffix}` : "Thinking",
          accelerator: "T",
          checked: cue?.mode === "thought",
          onSelect: toggleThoughtOnSelection,
        },
        {
          kind: "item",
          label: many ? `Fill${suffix} with AI…` : "Fill with AI…",
          accelerator: "Ctrl+G",
          // Built from the targets, not the selection state, which has not
          // re-rendered yet when the menu opens on an unselected cue.
          onSelect: () => {
            const chosen = cues.filter((c) => targets.has(c.id));
            const last = chosen[chosen.length - 1];
            setFillOpen({
              selectedCueIds: chosen.map((c) => c.id),
              continueAfter: last ? last.end : currentTime,
              initialKind: "fill",
            });
          },
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
      toggleThoughtOnSelection,
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
  const hasProject =
    Boolean(paths) ||
    cues.length > 0 ||
    speakers.length > 0 ||
    project.brief.trim() !== "" ||
    project.beats.some((beat) => beat.trim() !== "") ||
    sections.length > 0;
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
          label: "Transcribe…",
          disabled: !project.videoPath,
          onSelect: () => setShowTranscribe(true),
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
        {
          kind: "item",
          label: "Export voiceover audio…",
          disabled: !canExportAudio,
          onSelect: () => setShowExportAudio(true),
        },
        {
          kind: "item",
          label: "Clean up unused voice files…",
          disabled: !paths,
          onSelect: () => void cleanUpVoiceFiles(),
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
          label: `Fit${selectionLabel} to reading speed`,
          accelerator: "R",
          disabled: !primaryId,
          onSelect: fitSelectionToReadingSpeed,
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
          label: "Flag a section at the playhead",
          accelerator: "B",
          onSelect: addSectionAtPlayhead,
        },
        { kind: "separator" },
        {
          kind: "item",
          label: selectedIds.size > 0 ? "Fill or continue with AI…" : "Continue with AI…",
          accelerator: "Ctrl+G",
          onSelect: openFill,
        },
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
          label: "Previous section",
          accelerator: "PgUp",
          disabled: !previousSection(sections, currentTime),
          onSelect: () => jumpToSection(-1),
        },
        {
          kind: "item",
          label: "Next section",
          accelerator: "PgDn",
          disabled: !nextSection(sections, currentTime),
          onSelect: () => jumpToSection(1),
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
        {
          kind: "item",
          label: "Autocomplete cue text",
          accelerator: "Ctrl+Shift+Space",
          detail: apiKeySet ? undefined : "Add an OpenRouter key in Settings",
          checked: settings.ghostEnabled,
          onSelect: toggleGhost,
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

        <div className="segmented workspace-tabs" role="tablist" aria-label="Workspace">
          {(["edit", "subtitles", "voiceover"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={workspace === id}
              className={workspace === id ? "small on" : "small"}
              onClick={() => setWorkspace(id)}
            >
              {id === "edit" ? "Edit" : id === "subtitles" ? "Subtitles" : "Voiceover"}
            </button>
          ))}
        </div>

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

        {/* The waveform's controls; the Edit tab has its own zoom and clock. */}
        <div className="toolbar-group" hidden={editMode}>
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

      <EditWorkspace
        ref={editRef}
        active={editMode}
        edit={project.edit}
        videoPath={project.videoPath}
        media={media}
        projectPath={projectPath}
        hasTimedWork={cues.length > 0 || project.voiceover.clips.length > 0}
        setEdit={setEdit}
        onBaked={adoptBake}
        project={project}
        onRevealTimed={revealTimed}
        onDeleteLost={deleteLost}
        notify={notify}
        sideWidth={sideWidth}
        onSideWidth={setSideWidth}
        keysEnabled={!modalOpen && !menuOpen && !contextMenu}
      />

      {/* Kept mounted under the Edit tab, so the player, the mix and the chat
          keep their state. */}
      <main
        className={voiceoverMode ? "layout voiceover" : "layout"}
        hidden={editMode}
        style={{ "--side-width": `${sideWidth}px` } as CSSProperties}
      >
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

          {!voiceoverMode && (
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
            sections={sections}
            selectedSectionId={selectedSectionId}
            onSelectSection={setSelectedSectionId}
            onMoveSection={moveSectionTo}
            onContextMenuSection={openSectionContextMenu}
            onContextMenuLane={openLaneContextMenu}
          />
          )}
        </div>

        <SideResizer width={sideWidth} onWidth={setSideWidth} />

        <aside className="side-column">
          {voiceoverMode ? (
            <>
            <div className="segmented wide side-tabs" role="tablist" aria-label="Side panel">
              {VO_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={voTab === tab.id}
                  className={voTab === tab.id ? "small on" : "small"}
                  onClick={() => setVoTab(tab.id)}
                  title={tab.title}
                >
                  {tab.label}
                  {tab.id === "cast" && voices.job && <span className="side-tab-dot" title="Speaking lines" />}
                  {tab.id === "clip" && selectedClip && clipWarnings.has(selectedClip.id) && (
                    <span className="side-tab-warning"> ⚠</span>
                  )}
                </button>
              ))}
            </div>
            <div className="side-tab-body" hidden={voTab !== "cast"}>
            <CastPanel
              voiceover={project.voiceover}
              lines={lines}
              speakers={speakers}
              status={voices.status}
              job={voices.job}
              canGenerate={Boolean(paths)}
              onInstall={() => setShowTtsInstall(true)}
              onGenerate={(list) => void voices.generate(list)}
              onStop={voices.stop}
              onSetVoice={(key, patch) =>
                setVoiceover((v) => setVoice(v, key, patch), `voice:${key}:${Object.keys(patch).join()}`)
              }
              onSetPronunciation={(word, spoken) =>
                setVoiceover((v) => setPronunciation(v, word, spoken))
              }
              onReferenceFromFile={(key) => void referenceFromFile(key)}
              onReferenceFromVideo={setReferenceKey}
              onDirect={
                apiKeySet
                  ? () => {
                      setChatPrefill((p) => ({ text: "/direct ", nonce: (p?.nonce ?? 0) + 1 }));
                      setVoTab("chat");
                    }
                  : undefined
              }
            />
            </div>
            <div className="side-tab-body" hidden={voTab !== "line"}>
            {editedCue ? (
              <LineEditor
                // A fresh editor per cue, so a suggestion in flight for one
                // cue can never land in another.
                key={editedCue.id}
                cue={editedCue}
                speakerName={
                  speakers.find((s) => s.id === editedCue.speakerId)?.name ?? "No speaker"
                }
                voicing={project.voiceover.voicing[editedCue.id] ?? {}}
                groupSize={lines.groupOf(editedCue.id)?.length ?? 1}
                rendered={renderGroup(project.voiceover, lines.groupOf(editedCue.id) ?? [editedCue])}
                state={lines.stateOf(lines.groupOf(editedCue.id) ?? [editedCue])}
                canSpeak={Boolean(voices.status?.installed && paths)}
                onSuggest={apiKeySet ? () => suggestLine(editedCue) : undefined}
                onChange={(patch) =>
                  setVoiceover(
                    (v) => setVoicing(v, editedCue.id, editedCue.text, patch),
                    `voicing:${editedCue.id}:${Object.keys(patch).join()}`,
                  )
                }
                onGenerate={() => void voices.generate([editedCue])}
                onClose={() => setVoSel(EMPTY_SELECTION)}
              />
            ) : (
              <section className="panel line-editor">
                <header className="panel-header">
                  <h2>Voice line</h2>
                </header>
                <p className="hint side-tab-empty">
                  Select a cue, or a clip spoken from one, to write what is spoken: the words, tags
                  like [sigh], and a note on how.
                </p>
              </section>
            )}
            </div>
            <div className="side-tab-body" hidden={voTab !== "clip"}>
            <ClipInspector
              clip={selectedClip}
              track={
                selectedClip
                  ? project.voiceover.tracks.find((t) => t.id === selectedClip.trackId) ?? null
                  : null
              }
              cueText={selectedCueOfClip ? selectedCueOfClip.text : null}
              stale={selectedClip ? clipWarnings.get(selectedClip.id) === "stale" : false}
              overrun={selectedClip ? overrun(selectedClip, cues) : 0}
              fitRatio={selectedClip ? fitRatio(selectedClip, cues) : null}
              onSpeedUp={() => selectedClip && void speedUpClips([selectedClip.id])}
              canSpeak={Boolean(voices.status?.installed && paths)}
              onPatch={(patch) => selectedClip && patchClipById(selectedClip.id, patch)}
              onMoveToPlayhead={() =>
                selectedClip &&
                setVoiceover((v) => moveClip(v, selectedClip.id, currentTime))
              }
              onMoveToCue={() =>
                selectedClip &&
                selectedCueOfClip &&
                setVoiceover((v) => moveClip(v, selectedClip.id, selectedCueOfClip.start))
              }
              onSelectTake={(index) =>
                selectedClip && setVoiceover((v) => selectTake(v, selectedClip.id, index))
              }
              onRemoveTake={(index) =>
                selectedClip && setVoiceover((v) => removeTake(v, selectedClip.id, index))
              }
              onNewTake={() => selectedCueOfClip && void voices.generate([selectedCueOfClip])}
              onRemove={() => selectedClip && removeClipById(selectedClip.id)}
            />
            </div>
            </>
          ) : (
          <>
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

          <StoryPanel
            brief={project.brief}
            onBriefChange={setBrief}
            sections={sections}
            currentTime={currentTime}
            selectedId={selectedSectionId}
            renamingId={renamingSectionId}
            enabled={Boolean(videoUrl)}
            onAdd={addSectionAtPlayhead}
            onRename={renameSectionById}
            onNote={noteSectionById}
            onRemove={removeSectionById}
            onJump={jumpToSectionId}
            onRenamed={() => setRenamingSectionId(null)}
            timedBeats={timedBeats}
            duration={duration}
            onSeek={seek}
            onAddBeat={(beat) => setTimedBeats((list) => addBeat(list, beat))}
            onEditBeat={(id, patch) =>
              setTimedBeats((list) => editBeat(list, id, patch), `beat:${id}:${"time" in patch ? "time" : "text"}`)
            }
            onRemoveBeat={(id) => setTimedBeats((list) => removeBeat(list, id))}
            onStory={() => setChatPrefill((p) => ({ text: "/story ", nonce: (p?.nonce ?? 0) + 1 }))}
          />
          </>
          )}

          {/* Voiceover gives the chat a tab of its own, at full height. It stays
              mounted either way, so switching workspaces or tabs keeps the
              conversation. */}
          {!voiceoverMode && <PanelResizer height={chatHeight} onHeight={setChatHeight} />}

          <ChatPanel
            hidden={voiceoverMode && voTab !== "chat"}
            cues={cues}
            speakers={speakers}
            sections={sections}
            brief={project.brief}
            beats={project.beats}
            primaryId={primaryId}
            selectedIds={selectedIds}
            currentTime={currentTime}
            duration={duration}
            reading={{
              targetCps: settings.targetCps,
              minGap: settings.minGap,
              maxCharsPerLine: settings.maxCharsPerLine,
              maxLines: settings.maxLines,
            }}
            videoPath={project.videoPath}
            visionModel={settings.visionModel}
            models={settings.chatModels}
            model={resolveChatModel(settings.chatModels, settings.chatModel)}
            effort={settings.chatEffort}
            temperature={settings.temperature}
            linesBefore={settings.chatLinesBefore}
            apiKeySet={apiKeySet}
            // The video, not the project path: saving a new project for the
            // first time gives it a path, and must not wipe the conversation.
            projectKey={project.videoPath}
            height={voiceoverMode ? undefined : chatHeight}
            onLinesChange={(lines) => patchSettings({ chatLinesBefore: lines })}
            onModelChange={(chatModel) => patchSettings({ chatModel })}
            onEffortChange={(chatEffort) => patchSettings({ chatEffort })}
            onOpenSettings={() => setShowSettings(true)}
            timedBeats={timedBeats}
            voiceover={project.voiceover}
            prefill={chatPrefill}
            onAgentPatch={applyAgentPatch}
            onAgentDone={(created) => {
              if (created.length > 0) selectOnly(created[created.length - 1]);
            }}
          />
        </aside>

        <section className="list-row">
          {voiceoverMode ? (
            <VoiceoverTimeline
              voiceover={project.voiceover}
              cues={cues}
              speakers={speakers}
              peaks={peaks}
              peaksPerSecond={settings.peaksResolution}
              duration={duration}
              currentTime={currentTime}
              playing={playing}
              zoom={zoom}
              follow={follow}
              selection={voSel}
              clipPeaks={(file) => mixer?.peaksFor(file) ?? null}
              decodeVersion={decodeVersion}
              onSeek={seek}
              onZoomChange={setZoom}
              onSelect={selectVo}
              onMoveSelection={moveSelection}
              onPatchTrack={patchTrackById}
              onAddTrack={() => setVoiceover(addTrack)}
              onRemoveTrack={(id) => setVoiceover((v) => removeTrack(v, id))}
              onImport={(trackId) => void importAudio(trackId)}
              onMoveClip={(id, start, trackId, drag) =>
                dragVoiceover((v) => moveClip(v, id, start, trackId), drag)
              }
              onTrimClip={(id, edge, time, drag) =>
                dragVoiceover(
                  (v) => (edge === "start" ? trimClipStart(v, id, time) : trimClipEnd(v, id, time)),
                  drag,
                )
              }
              duck={duckPoints}
              onExport={canExportAudio ? () => setShowExportAudio(true) : undefined}
              clipWarnings={clipWarnings}
              lineJoins={lineJoins}
              onContextMenuCue={openVoiceCueMenu}
              onEditCueLine={editCueLine}
              onRetimeCue={retimeCueInVoiceover}
              onToggleCueDuck={(cueId) => setVoiceover((v) => toggleCueDuck(v, cueId))}
              onDuckChange={(patch) =>
                setVoiceover((v) => patchDuck(v, patch), `duck:${Object.keys(patch).join()}`)
              }
              onDuckAllCues={() =>
                setVoiceover((v) =>
                  v.unduckedCueIds.length ? { ...v, unduckedCueIds: [] } : v,
                )
              }
              onCurveChange={(trackId, points, drag) =>
                drag
                  ? dragVoiceover((v) => setAutomation(v, trackId, points), drag)
                  : setVoiceover((v) => setAutomation(v, trackId, points))
              }
            />
          ) : (
          <>
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
            recutFlag={(cue) => recutFlag(project.edit?.recut, "cue", cue.id, cue.start)}
            onSelect={select}
            onContextMenu={openCueContextMenu}
            onSeek={seek}
            onEditText={editText}
            onEditTiming={editTiming}
            onAssignSpeaker={assignSpeaker}
            onToggleThought={toggleThought}
            ghost={ghost}
          />
          </>
          )}
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

      {fillOpen && (
        <FillDialog
          selectedCueIds={fillOpen.selectedCueIds}
          continueAfter={fillOpen.continueAfter}
          initialKind={fillOpen.initialKind}
          cues={cues}
          speakers={speakers}
          sections={sections}
          brief={project.brief}
          beats={project.beats}
          timedBeats={timedBeats}
          settings={settings}
          duration={duration}
          apiKeySet={apiKeySet}
          onBriefChange={setBrief}
          onBeatsChange={setBeats}
          onSpeakerChange={updateSpeaker}
          onSectionNoteChange={noteSectionById}
          onSettingsChange={patchSettings}
          onConfirm={confirmReplace}
          onAccept={acceptFill}
          onOpenSettings={() => {
            setFillOpen(null);
            setShowSettings(true);
          }}
          onClose={() => setFillOpen(null)}
        />
      )}

      {showProofread && (
        <ProofreadDialog
          cues={cues}
          selectedIds={selectedIds}
          model={settings.model}
          onApply={spellcheck.addCorrections}
          onClose={() => setShowProofread(false)}
        />
      )}

      {showTranscribe && project.videoPath && (
        <TranscribeDialog
          videoPath={project.videoPath}
          cueCount={cues.length}
          model={settings.whisperModel || DEFAULT_WHISPER_MODEL}
          language={settings.whisperLanguage}
          onChoiceChange={({ model, language }) => {
            const next = {
              ...settings,
              whisperModel: model,
              whisperLanguage: language,
            };
            setSettings(next);
            api.saveSettings(next).catch((e) => notify(errorMessage(e), "error"));
          }}
          onDone={(srt) => applyImportedSrt(srt, "Transcribed")}
          onClose={() => setShowTranscribe(false)}
        />
      )}

      {showRender && paths && (
        <RenderDialog
          videoPath={project.videoPath}
          defaultOutput={paths.burned}
          assPath={paths.ass}
          assText={assText}
          duration={duration}
          mix={mixdownRequest}
          onTargetLufs={setTargetLufs}
          onClose={() => setShowRender(false)}
        />
      )}

      {referenceKey !== null && (
        <ReferenceDialog
          speakerName={
            referenceKey === NO_SPEAKER
              ? "the unassigned"
              : speakers.find((s) => s.id === referenceKey)?.name ?? "this speaker"
          }
          cues={cues.filter((c) => castKey(c) === referenceKey)}
          initial={
            new Set(
              voiceFor(project.voiceover, referenceKey).referenceCueIds ??
                suggestedReferenceCues(cues, referenceKey).map((c) => c.id),
            )
          }
          playingId={previewCueId}
          onPlay={previewCue}
          onStop={stopPreview}
          onBuild={(chosen) => buildReference(referenceKey, chosen)}
          onClose={() => setReferenceKey(null)}
        />
      )}

      {showTtsInstall && (
        <TtsInstallDialog
          status={voices.status}
          onInstalled={voices.refreshStatus}
          onClose={() => setShowTtsInstall(false)}
        />
      )}

      {showExportAudio && paths && (
        <ExportAudioDialog
          defaultOutput={`${paths.dir}${paths.dir.includes("\\") ? "\\" : "/"}${paths.stem}.voiceover.wav`}
          request={mixdownRequest}
          onTargetLufs={setTargetLufs}
          onClose={() => setShowExportAudio(false)}
        />
      )}
    </div>
  );
}
