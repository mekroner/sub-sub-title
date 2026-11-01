/** Typed wrappers around the Rust commands. */

import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AgentReply,
  AgentRequest,
  AppState,
  ChatRequest,
  CueIssues,
  EngineStatus,
  FillRequest,
  GhostRequest,
  MediaInfo,
  MixdownRequest,
  MixdownResult,
  ModelInfo,
  Peaks,
  ProjectPaths,
  ProofreadCorrection,
  RenderPlan,
  TemplateFile,
  ScriptLine,
  Settings,
  SpellDialect,
  StoryBeatsRequest,
  ToolStatus,
  TtsRequest,
  TtsResult,
  ReferenceResult,
  TtsStatus,
  UnusedFile,
  VoiceTemplate,
} from "../types";

export const readTextFile = (path: string) =>
  invoke<string>("read_text_file", { path });

export const writeTextFile = (path: string, contents: string) =>
  invoke<void>("write_text_file", { path, contents });

export const fileExists = (path: string) => invoke<boolean>("file_exists", { path });

export const startupFile = () => invoke<string | null>("startup_file");

export const derivePaths = (videoPath: string) =>
  invoke<ProjectPaths>("derive_paths", { videoPath });

export const probeMedia = (path: string) => invoke<MediaInfo>("probe_media", { path });

export const computePeaks = (path: string, pointsPerSecond: number, refresh = false) =>
  invoke<Peaks>("compute_peaks", { path, pointsPerSecond, refresh });

export const checkTools = () => invoke<ToolStatus>("check_tools");

export const loadSettings = () => invoke<Settings>("load_settings");

export const saveSettings = (settings: Settings) =>
  invoke<void>("save_settings", { settings });

export const hasApiKey = () => invoke<boolean>("has_api_key");

export const setApiKey = (key: string) => invoke<void>("set_api_key", { key });

export const clearApiKey = () => invoke<void>("clear_api_key");

export const loadAppState = () => invoke<AppState>("load_app_state");

export const rememberProject = (path: string, videoPath: string) =>
  invoke<AppState>("remember_project", { path, videoPath });

export const rememberPosition = (path: string, position: number) =>
  invoke<void>("remember_position", { path, position });

export const forgetProject = (path: string) =>
  invoke<AppState>("forget_project", { path });

export const clearLastProject = () => invoke<AppState>("clear_last_project");

export const aiStoryBeats = (request: StoryBeatsRequest) =>
  invoke<string[]>("ai_story_beats", { request });

/** Sends a prompt built by `lib/fill.ts`; returns the model's raw reply. */
export const aiFill = (request: FillRequest) => invoke<string>("ai_fill", { request });

/** Sends a prompt built by `lib/ghost.ts`; returns the model's raw reply. */
export const aiGhost = (request: GhostRequest) => invoke<string>("ai_ghost", { request });

/** Abandons the in-flight autocomplete request, if any. */
export const cancelGhost = () => invoke<void>("cancel_ghost");

/** The error a superseded or cancelled autocomplete request rejects with. */
export const GHOST_CANCELLED = "cancelled";

/**
 * Streams a reply to a conversation built by `lib/chat.ts`, handing each piece
 * of text to `onDelta` as it arrives. Settles when the reply is complete.
 */
export function aiChat(request: ChatRequest, onDelta: (text: string) => void) {
  const onEvent = new Channel<{ kind: "delta"; text: string }>();
  onEvent.onmessage = (event) => onDelta(event.text);
  return invoke<void>("ai_chat", { request, onEvent });
}

/** Stops the reply being streamed, if any. */
export const cancelChat = () => invoke<void>("cancel_chat");

/** The error a stopped chat reply rejects with. */
export const CHAT_CANCELLED = "cancelled";

/**
 * One turn of a `/continue` run built by `lib/agent.ts`: the assistant's
 * message, tool calls and all. Stopped by `cancelChat` like a chat reply.
 */
export const aiAgentStep = (request: AgentRequest) =>
  invoke<AgentReply>("ai_agent_step", { request });

/**
 * A frame of the video described in words by a vision model, for a
 * `/continue` run. The image itself stays in the backend. Stopped by
 * `cancelChat`.
 */
export const aiDescribeFrame = (request: {
  videoPath: string;
  time: number;
  model: string;
  question?: string;
}) => invoke<string>("ai_describe_frame", { request });

export const listModels =() => invoke<ModelInfo[]>("list_models");

export const renderBurnIn = (args: {
  videoPath: string;
  assPath: string;
  outputPath: string;
  duration: number;
  crf?: number;
  /** The voiceover mix to use as the video's audio; absent keeps its own. */
  audio?: Omit<MixdownRequest, "outputPath"> | null;
}) => invoke<void>("render_burn_in", args);

export const cancelRender = () => invoke<void>("cancel_render");

/**
 * Renders a teaser: the video up to `at` with subtitles and the mix (or its
 * own sound), faded over `fade`, then the post-teaser screen `post`. Progress
 * arrives as `render-progress`; `cancelRender` stops it.
 */
export const renderTeaser = (args: {
  videoPath: string;
  assPath: string;
  outputPath: string;
  at: number;
  fade: number;
  crf?: number;
  audio?: Omit<MixdownRequest, "outputPath"> | null;
  hasAudio: boolean;
  post: RenderPlan;
}) => invoke<void>("render_teaser", args);

/** Writes a PNG into the bake's work dir under `name`; returns the name. */
export const stageEditImage = (name: string, png: Uint8Array) =>
  invoke<string>("stage_edit_image", png, { headers: { "x-name": name } });

/** Bakes the Edit tab's plan into `outputPath`. Progress arrives as `bake-progress`. */
export const bakeEdit = (args: { plan: RenderPlan; outputPath: string; crf?: number }) =>
  invoke<void>("bake_edit", args);

export const cancelBake = () => invoke<void>("cancel_bake");

/** The folder overlay templates are saved to and listed from. */
export const templatesDir = () => invoke<string>("templates_dir");

/** Every template in that folder, newest first. */
export const listTemplates = () => invoke<TemplateFile[]>("list_templates");

/**
 * Writes a PNG into a project's assets folder; false when an identical file
 * was already there. The path is percent-encoded: headers carry ASCII only.
 */
export const writeAssetPng = (path: string, png: Uint8Array) =>
  invoke<boolean>("write_asset_png", png, { headers: { "x-path": encodeURIComponent(path) } });

/** An image file's bytes. */
export const readImageFile = async (path: string) =>
  new Uint8Array(await invoke<ArrayBuffer>("read_image_file", { path }));

/** Sends an earlier bake nothing uses any more to the Recycle Bin. */
export const trashBake = (path: string) => invoke<void>("trash_bake", { path });

export const mixdownVoiceover = (request: MixdownRequest) =>
  invoke<MixdownResult>("mixdown_voiceover", { request });

export const cancelMixdown = () => invoke<void>("cancel_mixdown");

/** A cue's line rewritten for the voice engine, following a direction note. */
export const aiDirectLine = (request: {
  model: string;
  speaker: string;
  voiceNotes: string;
  text: string;
  spoken: string;
  direction: string;
  engine: string;
  before: ScriptLine[];
  after: ScriptLine[];
}) => invoke<string>("ai_direct_line", { request });

export const ttsStatus = () => invoke<TtsStatus>("tts_status");
export const installTts = () => invoke<void>("install_tts");
export const cancelTtsInstall = () => invoke<void>("cancel_tts_install");
export const ttsGenerate = (request: TtsRequest) =>
  invoke<TtsResult>("tts_generate", { request });
/** Stops the voice engine, freeing the GPU memory its model holds. */
export const ttsUnload = () => invoke<void>("tts_unload");
/** Voice templates, newest first. */
export const listVoiceTemplates = () => invoke<VoiceTemplate[]>("list_voice_templates");
/** Keeps a copy of a reference clip as a new voice template. */
export const saveVoiceTemplate = (name: string, source: string) =>
  invoke<VoiceTemplate>("save_voice_template", { name, source });
export const renameVoiceTemplate = (id: string, name: string) =>
  invoke<VoiceTemplate>("rename_voice_template", { id, name });
/** Its clip goes to the Recycle Bin. */
export const deleteVoiceTemplate = (id: string) => invoke<void>("delete_voice_template", { id });
export const ttsExtractReference = (
  videoPath: string,
  segments: Array<[number, number]>,
  outputPath: string,
) => invoke<ReferenceResult>("tts_extract_reference", { videoPath, segments, outputPath });

/** Filesystem checks only — safe to call whenever the dialog opens. */
export const transcribeStatus = (model: string) =>
  invoke<EngineStatus>("transcribe_status", { model });

export const installEngine = (model: string) =>
  invoke<EngineStatus>("install_engine", { model });

export const transcribeVideo = (args: {
  videoPath: string;
  language: string | null;
  model: string;
}) => invoke<string>("transcribe_video", args);

/** Cancels an engine download, an unpack, or a transcription — whichever runs. */
export const cancelTranscribe = () => invoke<void>("cancel_transcribe");

export const checkCues = (request: {
  cues: Array<{ id: string; text: string }>;
  dialect: SpellDialect;
  ignored: string[];
}) => invoke<CueIssues[]>("check_cues", { request });

export const aiProofread = (request: {
  model: string;
  cues: Array<{ id: string; text: string }>;
}) => invoke<ProofreadCorrection[]>("ai_proofread", { request });

export const cancelProofread = () => invoke<void>("cancel_proofread");

export const loadUserDictionary = () => invoke<string[]>("load_user_dictionary");

export const saveUserDictionary = (words: string[]) =>
  invoke<void>("save_user_dictionary", { words });

/** Tauri command errors arrive as plain strings; normalise for display. */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Writes `input` played `ratio` times as fast, same pitch; resolves to its length. */
export const ttsStretch = (input: string, output: string, ratio: number) =>
  invoke<number>("tts_stretch", { input, output, ratio });

/** The `.wav` files in a voiceover folder that none of `keep` names. */
export const voiceoverUnusedFiles = (dir: string, keep: string[]) =>
  invoke<UnusedFile[]>("voiceover_unused_files", { dir, keep });

/** Moves voice files to the Recycle Bin; resolves to the bytes freed. */
export const voiceoverTrashFiles = (dir: string, files: string[]) =>
  invoke<number>("voiceover_trash_files", { dir, files });
