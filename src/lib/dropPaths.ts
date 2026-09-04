/**
 * Deciding what a set of dropped paths means. Pure, so the behaviour is testable
 * without an OS-level drag.
 */

export const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "webm", "mkv"];

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
