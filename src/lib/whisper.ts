/**
 * Choices offered by the transcribe dialog.
 *
 * Faster-Whisper-XXL accepts far more languages than these, but a select with
 * a hundred entries is worse than one with the languages people actually
 * subtitle in — and auto-detect covers the rest.
 */

export interface WhisperLanguage {
  /** The --language value. Empty means auto-detect (the flag is omitted). */
  code: string;
  label: string;
}

export const AUTO_DETECT = "";

export const WHISPER_LANGUAGES: WhisperLanguage[] = [
  { code: AUTO_DETECT, label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "ar", label: "Arabic" },
  { code: "zh", label: "Chinese" },
  { code: "cs", label: "Czech" },
  { code: "da", label: "Danish" },
  { code: "nl", label: "Dutch" },
  { code: "fi", label: "Finnish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "el", label: "Greek" },
  { code: "he", label: "Hebrew" },
  { code: "hi", label: "Hindi" },
  { code: "hu", label: "Hungarian" },
  { code: "id", label: "Indonesian" },
  { code: "it", label: "Italian" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "no", label: "Norwegian" },
  { code: "pl", label: "Polish" },
  { code: "pt", label: "Portuguese" },
  { code: "ro", label: "Romanian" },
  { code: "ru", label: "Russian" },
  { code: "es", label: "Spanish" },
  { code: "sv", label: "Swedish" },
  { code: "th", label: "Thai" },
  { code: "tr", label: "Turkish" },
  { code: "uk", label: "Ukrainian" },
  { code: "vi", label: "Vietnamese" },
];

export interface WhisperModel {
  /** The --model value. */
  id: string;
  label: string;
  /** Roughly what the first run has to download, for the dropdown label. */
  sizeLabel: string;
}

export const DEFAULT_WHISPER_MODEL = "medium";

export const WHISPER_MODELS: WhisperModel[] = [
  { id: "tiny", label: "Tiny — fastest, roughest", sizeLabel: "75 MB" },
  { id: "base", label: "Base", sizeLabel: "145 MB" },
  { id: "small", label: "Small", sizeLabel: "480 MB" },
  { id: "medium", label: "Medium — recommended", sizeLabel: "1.5 GB" },
  { id: "large-v3", label: "Large v3 — slowest, best", sizeLabel: "3.1 GB" },
];

export function modelLabel(id: string): string {
  return WHISPER_MODELS.find((m) => m.id === id)?.label ?? id;
}

export function modelSize(id: string): string {
  return WHISPER_MODELS.find((m) => m.id === id)?.sizeLabel ?? "";
}

/** "1.4 GB", "480 MB", "12 KB" — for download progress and size warnings. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** "3 min 20 s left", or null when the estimate is not yet meaningful. */
export function formatEta(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${Math.round(seconds)} s left`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min left`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}
