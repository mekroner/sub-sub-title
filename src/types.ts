export interface Speaker {
  id: string;
  name: string;
  /** Hex, e.g. "#ff8800". Used for the region, list row, and caption overlay. */
  color: string;
  /** Short persona/style description fed to the continue-feature. */
  voiceNotes?: string;
}

export interface Cue {
  id: string;
  /** Seconds. */
  start: number;
  /** Seconds. */
  end: number;
  text: string;
  speakerId: string | null;
}

export interface Project {
  videoPath: string;
  cues: Cue[];
  speakers: Speaker[];
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
  contextLines: number;
  candidateCount: number;
  styleNotes: string;
  fontName: string;
  fontSize: number;
  bold: boolean;
  outline: number;
  /** Hex. The .ass OutlineColour, and the preview's stroke. */
  outlineColor: string;
  shadow: number;
  /** Hex. The .ass BackColour, and the preview's drop shadow. */
  shadowColor: string;
  peaksResolution: number;
  /** Seconds of enforced silence between adjacent cues. */
  minGap: number;
  maxCharsPerLine: number;
  maxLines: number;
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

export interface ContinueContextLine {
  speaker: string;
  text: string;
}

export interface ContinueRequest {
  model: string;
  temperature: number;
  candidateCount: number;
  styleNotes: string;
  speakerName: string;
  voiceNotes: string;
  context: ContinueContextLine[];
}
