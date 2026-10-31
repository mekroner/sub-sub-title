/**
 * Deciding what a set of dropped paths means. Pure, so the behaviour is testable
 * without an OS-level drag.
 */

export const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "webm", "mkv"];
/** Stills the Edit tab can place: what both ffmpeg and the webview read. */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp"];

export type DropIntent =
  | { kind: "project"; path: string }
  | { kind: "video"; path: string }
  | { kind: "srt"; path: string }
  | { kind: "none" };

function hasExtension(path: string, extensions: string[]): boolean {
  const lower = path.toLowerCase();
  return extensions.some((ext) => lower.endsWith(`.${ext}`));
}

/**
 * A project file wins over everything, and a video over a subtitle file:
 * dropping both is most likely "open this", not "import cues into whatever is
 * already open".
 */
export function classifyDrop(paths: string[]): DropIntent {
  const project = paths.find((p) => hasExtension(p, ["sstproj"]));
  if (project) return { kind: "project", path: project };

  const video = paths.find((p) => hasExtension(p, VIDEO_EXTENSIONS));
  if (video) return { kind: "video", path: video };

  const srt = paths.find((p) => hasExtension(p, ["srt"]));
  if (srt) return { kind: "srt", path: srt };

  return { kind: "none" };
}

export type EditDropIntent =
  | { kind: "project"; path: string }
  | { kind: "media"; videos: string[]; images: string[] }
  | { kind: "none" };

/**
 * In the Edit tab, dropped videos and images are sources for the cut — all of
 * them, in the order dropped. A project file still wins: that is "open this".
 */
export function classifyEditDrop(paths: string[]): EditDropIntent {
  const project = paths.find((p) => hasExtension(p, ["sstproj"]));
  if (project) return { kind: "project", path: project };
  const videos = paths.filter((p) => hasExtension(p, VIDEO_EXTENSIONS));
  const images = paths.filter((p) => hasExtension(p, IMAGE_EXTENSIONS));
  if (videos.length + images.length === 0) return { kind: "none" };
  return { kind: "media", videos, images };
}
