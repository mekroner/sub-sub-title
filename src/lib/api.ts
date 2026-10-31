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
  Settings,
  SpellDialect,
  StoryBeatsRequest,
  ToolStatus,
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
}) => invoke<void>("render_burn_in", args);

export const cancelRender = () => invoke<void>("cancel_render");

export const mixdownVoiceover = (request: MixdownRequest) =>
  invoke<MixdownResult>("mixdown_voiceover", { request });

export const cancelMixdown = () => invoke<void>("cancel_mixdown");

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
