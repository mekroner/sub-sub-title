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

/**
 * A story beat pinned to a moment: what happens, or should happen, there. Kept
 * at project level and grouped by section span for display, so moving or
 * removing a flag never strands one. Never exported.
 */
export interface TimedBeat {
  id: string;
  /** Seconds. */
  time: number;
  text: string;
  /** Written by the story agent; absent when the writer wrote it (or took it over). */
  by?: "agent";
}

/** A point on a track's gain curve. Phase 3 interpolates between them. */
export interface GainPoint {
  /** Seconds. */
  time: number;
  /** Relative to the track's own gain. */
  db: number;
}

/**
 * A lane in the voiceover mix. There is always exactly one `original` track —
 * the video's own audio — and up to `MAX_VOICE_TRACKS` voice tracks.
 */
export interface VoiceTrack {
  id: string;
  kind: "original" | "voice";
  name: string;
  /** Static gain in dB, applied on top of the curve. */
  gainDb: number;
  muted: boolean;
  solo: boolean;
  automation: GainPoint[];
}

/**
 * A stretch of an audio file placed on a voice track. The file is referenced,
 * never copied — like the video itself.
 */
export interface VoiceClip {
  id: string;
  trackId: string;
  /** Absolute path of the audio file. */
  file: string;
  /** Display name; the file's basename unless renamed. */
  name: string;
  /** Seconds on the timeline where the clip begins. */
  start: number;
  /** Seconds into the file where playback begins — the trimmed-off head. */
  offset: number;
  /** Seconds of the file that play, from `offset`. */
  duration: number;
  /** Length of the whole file, so a trim can never reach past its end. */
  sourceDuration: number;
  gainDb: number;
  /** Set when the clip was generated from a cue rather than imported. */
  source?: ClipSource;
  /** Every take generated for the cue; `file` is the one in use. */
  takes?: ClipTake[];
}

/** What a generated clip was spoken from, to tell when it has gone stale. */
export interface ClipSource {
  /**
   * The cues spoken as this one line, in order: usually one, more when a
   * sentence runs across several cues of the same speaker.
   */
  cueIds: string[];
  /** The text as it was spoken. */
  text: string;
  /** `voiceKey` of the cast entry it was spoken with. */
  voiceKey: string;
}

export interface ClipTake {
  file: string;
  seed: number;
  duration: number;
  /**
   * For a line spoken across several cues: where each cue's words start and
   * end in this take, in seconds, found by aligning the text to the audio.
   */
  marks?: Array<[number, number]>;
}

/** "turbo" takes inline tags like [laugh]; "standard" has an emotion setting. */
export type TtsEngine = "turbo" | "standard";

/** How one speaker is voiced. */
export interface CastVoice {
  /** A clip of the voice to clone. Absent means the model's default voice. */
  reference?: string;
  engine: TtsEngine;
  /** Standard engine only: 0.25 (flat) .. 2 (theatrical); 0.5 is neutral. */
  exaggeration: number;
  /** Standard engine only: how closely to follow the reference's pacing. */
  cfgWeight: number;
  temperature: number;
  /** The voice track this speaker's lines land on; absent picks one. */
  trackId?: string;
  /** The cues the reference was cut from, when it was built from the video. */
  referenceCueIds?: string[];
}

/** How the original track ducks under the cues. Applied live, never baked. */
export interface DuckSettings {
  enabled: boolean;
  /** How far the original drops under a cue, in dB (zero or negative). */
  depthDb: number;
  /** Seconds the fade down takes, ending where the cue begins. */
  attack: number;
  /** Seconds the fade back up takes, starting where the cue ends. */
  release: number;
  /** Gaps between ducked cues shorter than this (after the fades) stay down. */
  bridge: number;
}

export interface Voiceover {
  /** The original track first, then the voice tracks top to bottom. */
  tracks: VoiceTrack[];
  clips: VoiceClip[];
  duck: DuckSettings;
  /**
   * Cues the original does not duck under. Every cue ducks by default, so the
   * exceptions are what is stored — a new or split cue ducks without asking.
   */
  unduckedCueIds: string[];
  /** Voices by speaker id; `""` is the voice for cues with no speaker. */
  cast: Record<string, CastVoice>;
  /** How individual cues are voiced, by cue id. Most cues have no entry. */
  voicing: Record<string, CueVoicing>;
  /**
   * Overrides of the automatic grouping, keyed by the cue before the
   * boundary: "join" speaks it together with the next cue, "split" apart.
   */
  joins: Record<string, "join" | "split">;
}

/**
 * A cue's voice script, kept apart from its subtitle so that tags and
 * rewordings never reach the subtitles.
 */
export interface CueVoicing {
  /** What is spoken, tags included. Absent speaks the cue's own text. */
  spoken?: string;
  /** A free-text note, e.g. "whispered, out of breath". */
  direction?: string;
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
  /** Story beats with a time, in time order. Never exported. */
  timedBeats: TimedBeat[];
  /** The Voiceover tab's tracks and clips. */
  voiceover: Voiceover;
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
  /** Grey autocomplete while typing in a cue. */
  ghostEnabled: boolean;
  /** Model for autocomplete — small and cheap, since it runs on every pause. */
  ghostModel: string;
  /** Typing pause, in milliseconds, before a suggestion is requested. */
  ghostDelayMs: number;
  /** Dialogue lines autocomplete shows the model around the cue. */
  ghostLinesBefore: number;
  ghostLinesAfter: number;
  /** Dialogue lines the chat panel's "Last N lines" button attaches. */
  chatLinesBefore: number;
  /** Model ids the chat panel offers. The first is the fallback. */
  chatModels: string[];
  /** The chat panel's current pick; resolved by `resolveChatModel`. */
  chatModel: string;
  /** "" leaves reasoning to the model. A string, so an unknown value degrades. */
  chatEffort: string;
  /** Model that describes video frames for `/continue`. "" turns looking off. */
  visionModel: string;
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
  /** Takes images as input, so it can describe a frame. */
  vision: boolean;
}

export interface RenderProgress {
  fraction: number;
  timeSeconds: number;
  speed: string;
}

/** Everything the export mixer needs; it mixes exactly what the preview plays. */
export interface MixdownRequest {
  videoPath: string;
  /** False when the video has no audio stream. */
  includeOriginal: boolean;
  outputPath: string;
  duration: number;
  tracks: VoiceTrack[];
  clips: VoiceClip[];
  /** The original's automatic duck under the cues. */
  duck: GainPoint[];
}

export interface MixdownResult {
  seconds: number;
  /** Loudest sample before limiting, in dBFS. */
  peakDb: number;
  /** Samples past full scale, clamped. */
  clipped: number;
}

export interface MixdownProgress {
  fraction: number;
}

export interface TtsStatus {
  installed: boolean;
  version: string;
  downloadBytes: number;
  requiredFreeBytes: number;
  /** 0 when unknown. */
  diskFreeBytes: number;
}

export interface TtsInstallProgress {
  step: number;
  steps: number;
  label: string;
  detail: string;
}

/** "loading" while a model goes onto the GPU, then "ready". */
export interface TtsEvent {
  event: string;
  detail: string;
}

export interface TtsRequest {
  engine: TtsEngine;
  text: string;
  reference: string | null;
  seed: number;
  exaggeration: number;
  cfgWeight: number;
  temperature: number;
  outputPath: string;
  /**
   * For a line spoken across several cues: each cue's words, untagged, to be
   * found in the generated audio. Null for a single cue.
   */
  alignSegments: string[] | null;
}

export interface TtsResult {
  path: string;
  duration: number;
  /** Each aligned segment's start and end, in seconds; absent if not asked or not found. */
  marks?: Array<[number, number]>;
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

/** A stretch of script handed to the chat, captured when it was attached. */
export interface ChatAttachment {
  cueCount: number;
  /** Seconds: the first line's start and the last line's end. */
  from: number;
  to: number;
  /** Rendered in Fill's transcript format. */
  transcript: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachment?: ChatAttachment;
  /** The cues selected when the message was sent. */
  selection?: ChatAttachment;
  /** Absent once a reply has finished normally. */
  status?: "streaming" | "stopped" | "error";
  /** Set on the reply to a `/continue` run: what it did to the script. */
  agent?: AgentRun;
}

/** One thing a `/continue` run did, as the chat log lists it. */
export interface AgentStep {
  kind: "read" | "add" | "edit" | "move" | "delete" | "look" | "ask" | "section" | "outline" | "error";
  label: string;
  /** More to read on demand: what a look saw, how a question was answered. */
  detail?: string;
}

/** A question about direction a `/continue` run puts to the writer. */
export interface WriterQuestion {
  question: string;
  /** Two to four genuinely different directions. */
  options: Array<{ label: string; description?: string }>;
}

export type WriterAnswer =
  | { kind: "option"; label: string }
  | { kind: "own"; text: string }
  | { kind: "skipped" };

export interface AgentRun {
  /** Absent for a `/continue` run, which is what runs were before `/story`. */
  kind?: "story";
  /** Seconds: the window the run was allowed to change. */
  from: number;
  to: number;
  steps: AgentStep[];
  /** The model's closing words, once it has finished. */
  summary?: string;
}

/** A tool call as OpenRouter returns it; `arguments` is a JSON string. */
export interface AgentToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** The assistant's side of a tool turn, sent back exactly as it came. */
export interface AgentReply {
  role: "assistant";
  content: string | null;
  tool_calls?: AgentToolCall[];
  [extra: string]: unknown;
}

/** One turn of a `/continue` conversation, in OpenAI's shape. */
export type AgentMessage =
  | { role: "system" | "user"; content: string }
  | AgentReply
  | { role: "tool"; tool_call_id: string; content: string };

/** One turn of a `/continue` run. Assembled in `lib/agent.ts`. */
export interface AgentRequest {
  model: string;
  /** Ignored by the backend when an effort is set. */
  temperature: number;
  maxTokens: number;
  reasoningEffort?: ChatEffort;
  messages: AgentMessage[];
  tools: unknown[];
}

/** How hard a reasoning model thinks before a chat reply. */
export type ChatEffort = "low" | "medium" | "high";

/** One chat reply request. Assembled in `lib/chat.ts`. */
export interface ChatRequest {
  model: string;
  /** Ignored by the backend when an effort is set. */
  temperature: number;
  maxTokens: number;
  reasoningEffort?: ChatEffort;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

/** One autocomplete request. Assembled in `lib/ghost.ts`. */
export interface GhostRequest {
  model: string;
  maxTokens: number;
  system: string;
  user: string;
}
