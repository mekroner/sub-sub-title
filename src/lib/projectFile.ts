/**
 * The `.sstproj` project file: cues, speakers, and a *reference* to the video.
 * The video itself is never copied, so a project is small and moves freely —
 * at the cost of breaking if the video is renamed, which the app reports.
 */

import type { Cue, Project, ProjectFile, Speaker } from "../types";
import { sortCues } from "./cues";
import { makeId } from "./ids";

export const PROJECT_EXTENSION = "sstproj";

export function serializeProjectFile(project: Project): string {
  const file: ProjectFile = {
    version: 1,
    savedAt: new Date().toISOString(),
    ...project,
  };
  return JSON.stringify(file, null, 2);
}

/** Basename without the extension — the project's display name. */
export function projectName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}

function coerceCue(raw: unknown): Cue | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Partial<Cue>;
  const start = Number(c.start);
  const end = Number(c.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return {
    id: typeof c.id === "string" && c.id ? c.id : makeId(),
    start,
    end,
    text: typeof c.text === "string" ? c.text : "",
    speakerId: typeof c.speakerId === "string" ? c.speakerId : null,
  };
}

function coerceSpeaker(raw: unknown): Speaker | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Partial<Speaker>;
  if (typeof s.name !== "string") return null;
  return {
    id: typeof s.id === "string" && s.id ? s.id : makeId(),
    name: s.name,
    color: typeof s.color === "string" ? s.color : "#888888",
    ...(typeof s.voiceNotes === "string" ? { voiceNotes: s.voiceNotes } : {}),
  };
}

/**
 * Tolerant of hand-edited and partial files: anything unusable is dropped
 * rather than failing the whole load. Only unparseable JSON throws.
 */
export function parseProjectFile(raw: string): Project {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("That project file is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("That project file is empty or malformed.");
  }

  const file = parsed as Partial<ProjectFile>;
  const cues = Array.isArray(file.cues)
    ? file.cues.map(coerceCue).filter((c): c is Cue => c !== null)
    : [];
  const speakers = Array.isArray(file.speakers)
    ? file.speakers.map(coerceSpeaker).filter((s): s is Speaker => s !== null)
    : [];

  // Written only since spellcheck existed, and hand-editable, so anything that
  // is not a non-empty string is dropped rather than failing the load.
  const dictionary = Array.isArray(file.dictionary)
    ? file.dictionary
        .filter((word): word is string => typeof word === "string")
        .map((word) => word.trim())
        .filter(Boolean)
    : [];

  return {
    videoPath: typeof file.videoPath === "string" ? file.videoPath : "",
    cues: sortCues(cues),
    speakers,
    dictionary,
  };
}
