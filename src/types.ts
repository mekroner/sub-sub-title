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
  /**
   * Where the voice starts and ends in the file, padded: the part a clip
   * plays, so the first word lands where the clip starts. Absent on takes
   * made before it was measured, which play whole.
   */
  speech?: [number, number];
  /** How well the take says its line, when that was checked. */
  check?: TakeCheck;
  /** Set on a take sped up to fit its cue: how much faster than spoken. */
  stretch?: number;
  /** For a stretched take: the file of the take as spoken. */
  original?: string;
}

export interface TakeCheck {
  /** How confidently the line's words were found in the take, 0..1. */
  score: number;
  /** Letters per second of speech. */
  rate: number;
}

/** "turbo" takes inline tags like [laugh]; "standard" has an emotion setting. */
export type TtsEngine = "turbo" | "standard";

/**
 * A reference clip kept beside the app, not a project, so a voice built once
 * can be given to speakers in any project. A speaker using one references
 * `file` directly.
 */
export interface VoiceTemplate {
  id: string;
  name: string;
  file: string;
  /**
   * The clip it was copied from. A speaker still referencing it is using
   * this template too, without their lines going stale.
   */
  source: string;
  /** 0 when it could not be measured. */
  seconds: number;
  /** Milliseconds since the Unix epoch. */
  createdAt: number;
}

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
  /**
   * Takes spoken per line, the best of them used: 1 (absent) to
   * `MAX_TAKES_PER_LINE`. More than one has every take checked.
   */
  takesPerLine?: number;
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
  /**
   * How words the voices get wrong are said, e.g. "Siobhan" → "shi-VAWN":
   * whole words, any case, in every line before it is spoken.
   */
  pronunciations?: Record<string, string>;
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
  /**
   * The Edit tab's cut, baked into the file `videoPath` then points at.
   * Absent until an edit is started; a project without one never changes.
   */
  edit?: Edit;
}

// --- The Edit tab -------------------------------------------------------------

/** What the edit renders into: pixel size (always even) and frame rate. */
export interface EditCanvas {
  width: number;
  height: number;
  fps: number;
}

export interface Edit {
  canvas: EditCanvas;
  sources: EditSource[];
  /** Index 0 is the main track; later tracks draw on top. */
  tracks: EditTrack[];
  items: EditItem[];
  /** The last bake: which file, and the plan it was made from. */
  baked?: EditBake;
  /** What the last re-cut could not move cleanly, until it is cleared. */
  recut?: RecutReport;
  /** Where a teaser export stops, and what it shows after. */
  teaser?: EditTeaser;
}

/**
 * A teaser: the finished video up to a cutoff, then a short screen made from
 * an overlay template over black.
 */
export interface EditTeaser {
  /** Edit-timeline seconds, which are the baked video's. */
  at: number;
  /** The post-teaser screen's template; none for plain black. */
  templatePath?: string;
  /** Seconds the post-teaser screen shows. */
  screen: number;
  /** Seconds of fade to black (and silence) up to the cutoff; 0 cuts hard. */
  fade: number;
}

/**
 * One stretch of a baked video and where it came from: the map that lets a
 * re-cut move cues and clips with the footage they were timed against.
 */
export interface CutSegment {
  /** Output seconds. */
  start: number;
  duration: number;
  /** A source file's path for video; `item:<id>` for a main-track image. */
  source: string;
  /** Seconds into the source (0 for images). */
  offset: number;
}

export type RecutKind = "cue" | "clip" | "section" | "beat";

/** Something a re-cut flagged, and where it put it (timeline seconds). */
export interface RecutRef {
  kind: RecutKind;
  id: string;
  /** Its start after the re-cut: a flag lapses once the item is moved. */
  at: number;
}

export interface RecutReport {
  /** ISO timestamp. */
  at: string;
  /** How many items moved cleanly with the cut. */
  moved: number;
  /** Partly in removed footage: moved with the larger kept part. */
  cut: RecutRef[];
  /** Only in removed footage: parked after the end of the video. */
  lost: RecutRef[];
  /** Gain-curve points that were in removed footage, and were dropped. */
  droppedPoints: number;
}

export interface EditBake {
  path: string;
  planHash: string;
  /** ISO timestamp. */
  at: string;
  /** What the baked video is made of, for the next re-cut. */
  segments?: CutSegment[];
}

/** A file the edit draws from. Referenced, never copied — like the video. */
export interface EditSource {
  id: string;
  /** Absolute path. */
  path: string;
  kind: "video" | "image";
  /** Displayed size, after any rotation. */
  width: number;
  height: number;
  /** Seconds; 0 for images. */
  duration: number;
  fps?: number;
  hasAudio: boolean;
  /** To warn when the preview cannot play it. */
  videoCodec?: string;
}

export interface EditTrack {
  id: string;
  kind: "main" | "overlay";
  name: string;
  hidden: boolean;
  /** Only the main track has audio in v1. */
  muted: boolean;
}

/**
 * Where an item sits at a moment, relative to its start. A static item has
 * one key; more are interpolated linearly.
 */
export interface TransformKey {
  time: number;
  /** Centre, as a fraction of the canvas width (0.5 = centred). */
  x: number;
  /** Centre, as a fraction of the canvas height. */
  y: number;
  /** 1 = fit inside the canvas (video, image) or the drawn size (text). */
  scale: number;
}

export interface EditItemBase {
  id: string;
  trackId: string;
  /** Timeline seconds. */
  start: number;
  duration: number;
  /** Seconds of alpha (and, for main-track video, audio) ramp at each end. */
  fadeIn: number;
  fadeOut: number;
  /** 0..1, the level the fades go to and from. */
  opacity: number;
  /** At least one key; times relative to the item's start. */
  transform: TransformKey[];
}

export interface VideoItem extends EditItemBase {
  kind: "video";
  sourceId: string;
  /** Seconds into the source where the item begins. */
  offset: number;
  gainDb: number;
}

export interface ImageItem extends EditItemBase {
  kind: "image";
  sourceId: string;
}

export interface TextStyle {
  fontFamily: string;
  /** Pixels at canvas resolution. */
  fontSize: number;
  color: string;
  weight: number;
  align: "left" | "center" | "right";
  outline?: { color: string; width: number };
  shadow?: { color: string; blur: number; dx: number; dy: number };
  background?: { color: string; padding: number };
}

export interface TextItem extends EditItemBase {
  kind: "text";
  text: string;
  style: TextStyle;
}

export type EditItem = VideoItem | ImageItem | TextItem;

/** One input of a bake, in output pixels and seconds. */
export interface PlanLayer {
  kind: "video" | "image";
  /** Absolute source path, or the staged PNG's name for text. */
  path: string;
  /** Text is staged in the bake's work dir rather than read from a source. */
  staged: boolean;
  start: number;
  duration: number;
  /** Seconds into the source; 0 for images. */
  offset: number;
  fadeIn: number;
  fadeOut: number;
  opacity: number;
  /** Resolved rect per key, in whole canvas pixels; time relative to start. */
  rects: PlanRect[];
  /** Present when this layer contributes sound. */
  audio?: { gainDb: number };
}

export interface PlanRect {
  time: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the backend needs to bake an edit, with every decision already made. */
export interface RenderPlan {
  width: number;
  height: number;
  fps: number;
  /** Seconds. */
  total: number;
  /** Bottom first. */
  layers: PlanLayer[];
}

export interface BakeProgress {
  fraction: number;
  timeSeconds: number;
  speed: string;
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
  /** Degrees clockwise the picture is displayed at; width/height already allow for it. */
  rotation?: number;
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

/** A file in a project's voiceover folder that nothing uses any more. */
export interface UnusedFile {
  path: string;
  bytes: number;
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
  /** The voiceover is mixed down first when the render uses it. */
  phase: "mixing" | "encoding";
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
  /** Integrated loudness to bring the whole mix to, in LUFS; null leaves it as mixed. */
  targetLufs: number | null;
}

export interface MixdownResult {
  seconds: number;
  /** Loudest sample before limiting, in dBFS. */
  peakDb: number;
  /** Samples past full scale, clamped. */
  clipped: number;
  /** The file's integrated loudness, when a target was set and could be measured. */
  lufs?: number;
  /** The target was out of reach without the true peak passing -1 dBTP. */
  limitedByPeak: boolean;
}

export interface MixdownProgress {
  fraction: number;
}

export interface TtsStatus {
  installed: boolean;
  /** Installed, but missing what newer versions add: it works, with less. */
  needsUpdate: boolean;
  version: string;
  /** What an update downloads. */
  updateBytes: number;
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

/** A cloning reference built from a speaker's lines in the video. */
export interface ReferenceResult {
  seconds: number;
  /** The lines it was asked to be cut from. */
  lines: number;
  /** How many made it in: lines that are mostly music are left out. */
  kept: number;
  /** Whether the voice was separated from the music and effects. */
  isolated: boolean;
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
  /** Also judge whether the take says the line; costs an alignment. */
  check: boolean;
}

export interface TtsResult {
  path: string;
  duration: number;
  /** Each aligned segment's start and end, in seconds; absent if not asked or not found. */
  marks?: Array<[number, number]>;
  /** Where the voice starts and ends in the take; absent if none was found. */
  speech?: [number, number];
  /** Present only when a check was asked for and could be made. */
  score?: number;
  rate?: number;
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
  kind: "read" | "add" | "edit" | "move" | "delete" | "look" | "ask" | "section" | "outline" | "direct" | "error";
  label: string;
  /** More to read on demand: what a look saw, how a question was answered. */
  detail?: string;
  /** How many things the step did, where it did several: lines a `/direct` call directed. */
  count?: number;
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
  kind?: "story" | "direct";
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

/** An overlay template in the library folder. */
export interface TemplateFile {
  path: string;
  name: string;
  /** Milliseconds since the epoch. */
  modified: number;
}
