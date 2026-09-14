export interface Speaker {
  id: string;
  name: string;
  /** Hex, e.g. "#ff8800". Used for the region, list row, and caption overlay. */
  color: string;
  /**
   * Hex. Caption colour for this speaker's thought cues. Absent means a muted
   * variant of `color` is derived instead, so a project made before modes
   * existed needs no setting up.
   */
  thinkingColor?: string;
  /** How this speaker talks — tone, vocabulary, quirks. Sent to Fill. */
  voiceNotes?: string;
  /**
   * How this speaker thinks, when that differs from how they talk. Sent to Fill
   * alongside the voice notes, so thoughts can sound unlike the speech.
   */
  innerVoice?: string;
}

/**
 * How a cue is voiced. Absent means ordinary spoken dialogue — a union rather
 * than a boolean so a later "whisper" or "narration" costs nothing.
 */
export type CueMode = "thought";

export interface Cue {
  id: string;
  /** Seconds. */
  start: number;
  /** Seconds. */
  end: number;
  text: string;
  speakerId: string | null;
  /**
   * Absent for spoken dialogue. A thought cue takes the speaker's thinking
   * colour and exports wrapped in `*asterisks*`; the markers live only in the
   * exported file, never in `text`.
   */
  mode?: CueMode;
}

/**
 * A named flag on the timeline: a cut, the start of a scene, a pickup to
 * reshoot. Never exported — these are the writer's own working notes.
 *
 * A section owns the span from its own `start` to the next section's, which is
 * why there is no `end`: sections cannot gap or overlap, and moving one never
 * has to negotiate with its neighbours.
 */
export interface Section {
  id: string;
  /** Seconds. */
  start: number;
  label: string;
  /**
   * What happens in this stretch, for Fill: who wants what, what has changed.
   * Absent when the writer never wrote one.
   */
  note?: string;
}

export interface Project {
  videoPath: string;
  cues: Cue[];
  speakers: Speaker[];
  /**
   * Words this project's spellchecker should leave alone — character names,
   * invented places. Optional: files written before spellcheck existed have none.
   */
  dictionary?: string[];
  /**
   * Premise, tone, world — what anyone writing lines for this project needs to
   * know. Free text, sent with every Fill request.
   */
  brief: string;
  /**
   * The core story beats, one per entry, in story order. Written by hand or
   * generated from the script, and sent to Fill so lines fit the larger story.
   * Blank entries are kept so the paragraph breaks the writer typed survive a
   * round trip; they are filtered where the beats are used, not where stored.
   */
  beats: string[];
  /** Timeline flags, in time order. Never exported. */
  sections: Section[];
}

/** The `.sstproj` project file. Versioned so the format can move later. */
export interface ProjectFile extends Project {
  version: 1;
  savedAt: string;
}

/**
 * The legacy `.captions.json` sidecar. Same shape; still read when opening a
 * bare video, never written any more.
 */
export type Sidecar = ProjectFile;

export interface RecentProject {
  path: string;
  videoPath: string;
  /** Milliseconds since the epoch. */
  openedAt: number;
  /** Seconds into the video when this project was last open. */
  position: number;
}

export interface AppState {
  lastProject: string | null;
  recentProjects: RecentProject[];
}

// --- Mirrors of the Rust command payloads ---

export interface MediaInfo {
  duration: number;
  hasAudio: boolean;
  hasVideo: boolean;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string;
}

export interface Peaks {
  peaks: number[];
  duration: number;
  pointsPerSecond: number;
}

export interface ProjectPaths {
  dir: string;
  stem: string;
  project: string;
  sidecar: string;
  srt: string;
  ass: string;
  burned: string;
}

export interface ToolStatus {
  ffmpeg: boolean;
  ffprobe: boolean;
  ffmpegVersion: string;
}

export interface Settings {
  model: string;
  temperature: number;
  /** The user's own instructions, added to Fill's built-in writing guidance. */
  fillInstructions: string;
  /** Replaces Fill's built-in writing guidance when non-empty. */
  fillGuidanceOverride: string;
  /** Dialogue lines Fill shows the model around the slots. */
  fillLinesBefore: number;
  fillLinesAfter: number;
  /** Alternative takes per Fill request. */
  fillTakes: number;
  fillLatitude: FillLatitude;
  fontName: string;
  fontSize: number;
  bold: boolean;
  outline: number;
  /** Hex. The .ass OutlineColour, and the preview's stroke. */
  outlineColor: string;
  shadow: number;
  /** Hex. The .ass BackColour, and the preview's drop shadow. */
  shadowColor: string;
  /** Wrap each exported .srt cue in its speaker's `<font color=…>`. */
  srtSpeakerColors: boolean;
  peaksResolution: number;
  /** Seconds of enforced silence between adjacent cues. */
  minGap: number;
  maxCharsPerLine: number;
  maxLines: number;
  /** Reading speed, in characters per second, that the fit-timing command aims for. */
  targetCps: number;
  spellcheck: boolean;
  dialect: SpellDialect;
  /** Whisper model size used by the transcribe dialog, e.g. "medium". */
  whisperModel: string;
  /** Whisper language code, or "" for auto-detect. */
  whisperLanguage: string;
  /**
   * Absolute path to a faster-whisper-xxl.exe installed by hand; "" to use the
   * copy the app downloads and manages itself.
   */
  whisperEnginePath: string;
}

export interface ModelInfo {
  id: string;
  name: string;
}

export interface RenderProgress {
  fraction: number;
  timeSeconds: number;
  speed: string;
}

/** Progress while the transcription engine is being downloaded and unpacked. */
export interface EngineProgress {
  phase: "downloading" | "verifying" | "extracting" | "locating" | "done";
  /** 0..1, or -1 when unknown. */
  fraction: number;
  bytesDone: number;
  bytesTotal: number;
  /** Bytes per second, or 0 when not applicable. */
  speedBps: number;
  /** Seconds remaining, or -1 when unknown. */
  etaSeconds: number;
  /** The archive entry being written, while extracting. */
  detail: string;
}

export interface TranscribeProgress {
  phase: "starting" | "modelDownload" | "vad" | "transcribing";
  /** 0..1, or -1 when unknown. */
  fraction: number;
  message: string;
}

export interface EngineStatus {
  installed: boolean;
  engineVersion: string;
  exePath: string | null;
  /** Bytes of an interrupted download still on disk, ready to resume. */
  partialBytes: number;
  downloadBytes: number;
  /** 0 when the free space could not be determined. */
  diskFreeBytes: number;
  /** Whether the chosen model has already been fetched by a previous run. */
  modelPresent: boolean;
}

export type SpellDialect = "american" | "british";

/** One problem found in a cue's text, by either checker. */
export interface CueIssue {
  /** UTF-16 offsets into the cue's text, so `slice()` works directly. */
  start: number;
  end: number;
  /** The offending text, for "Ignore <word>" and for display. */
  text: string;
  message: string;
  /** Harper's lint kind, or "Correction" for an AI finding. */
  kind: string;
  /** Ready-to-apply replacements for the span, best guess first. */
  replacements: string[];
  source: "harper" | "ai";
}

export interface CueIssues {
  id: string;
  issues: CueIssue[];
}

export interface ProofreadProgress {
  fraction: number;
  done: number;
  total: number;
}

export interface ProofreadCorrection {
  id: string;
  /** The whole cue text, rewritten. */
  corrected: string;
  reason: string;
}

export interface ScriptLine {
  speaker: string;
  text: string;
}

/** Distils the whole script into an outline. */
export interface StoryBeatsRequest {
  model: string;
  cues: ScriptLine[];
}

/**
 * How far Fill may stray from what is established. Each level is a paragraph of
 * prompt, not a temperature — temperature stays a setting of its own.
 */
export type FillLatitude = "close" | "open" | "wild";

/** A finished prompt, ready to send. Assembled in `lib/fill.ts`. */
export interface FillRequest {
  model: string;
  temperature: number;
  maxTokens: number;
  system: string;
  user: string;
}
