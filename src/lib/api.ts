/** Typed wrappers around the Rust commands. */

import { invoke } from "@tauri-apps/api/core";
import type {
  AppState,
  ContinueRequest,
  CueIssues,
  EngineStatus,
  MediaInfo,
  ModelInfo,
  Peaks,
  ProjectPaths,
  ProofreadCorrection,
  Settings,
  SpellDialect,
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

export const aiContinue = (request: ContinueRequest) =>
  invoke<string[]>("ai_continue", { request });

export const listModels = () => invoke<ModelInfo[]>("list_models");

export const renderBurnIn = (args: {
  videoPath: string;
  assPath: string;
  outputPath: string;
  duration: number;
  crf?: number;
}) => invoke<void>("render_burn_in", args);

export const cancelRender = () => invoke<void>("cancel_render");

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
