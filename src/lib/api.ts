/** Typed wrappers around the Rust commands. */

import { invoke } from "@tauri-apps/api/core";
import type {
  ContinueRequest,
  MediaInfo,
  ModelInfo,
  Peaks,
  ProjectPaths,
  Settings,
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

/** Tauri command errors arrive as plain strings; normalise for display. */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
