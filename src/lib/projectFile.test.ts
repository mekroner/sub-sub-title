import { describe, expect, it } from "vitest";

import {
  parseProjectFile,
  projectName,
  serializeProjectFile,
} from "./projectFile";
import type { Project } from "../types";

const project: Project = {
  videoPath: "D:/clips/interview.mp4",
  cues: [
    { id: "a", start: 0, end: 1.5, text: "Hello", speakerId: "s1" },
    { id: "b", start: 1.5, end: 3, text: "Goodbye", speakerId: null },
  ],
  speakers: [{ id: "s1", name: "Ada", color: "#ff8800", voiceNotes: "dry" }],
};

describe("serializeProjectFile / parseProjectFile", () => {
  it("round-trips a project", () => {
    expect(parseProjectFile(serializeProjectFile(project))).toEqual(project);
  });

  it("stamps a version and a save time", () => {
    const written = JSON.parse(serializeProjectFile(project));
    expect(written.version).toBe(1);
    expect(Number.isNaN(Date.parse(written.savedAt))).toBe(false);
  });

  it("sorts cues by start time", () => {
    const raw = JSON.stringify({
      videoPath: "v.mp4",
      cues: [
        { id: "b", start: 5, end: 6, text: "second", speakerId: null },
        { id: "a", start: 1, end: 2, text: "first", speakerId: null },
      ],
    });
    expect(parseProjectFile(raw).cues.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("fills in missing fields rather than failing", () => {
    const parsed = parseProjectFile("{}");
    expect(parsed).toEqual({ videoPath: "", cues: [], speakers: [] });
  });

  it("drops entries that have no usable timing or name", () => {
    const raw = JSON.stringify({
      cues: [{ start: "nope", end: 2 }, { start: 0, end: 1 }],
      speakers: [{ color: "#fff" }, { name: "Ada" }],
    });
    const parsed = parseProjectFile(raw);
    expect(parsed.cues).toHaveLength(1);
    expect(parsed.speakers).toHaveLength(1);
    // A cue missing an id still gets one, so React keys and selection work.
    expect(parsed.cues[0].id).toBeTruthy();
    expect(parsed.cues[0].text).toBe("");
  });

  it("throws a readable error on invalid JSON", () => {
    expect(() => parseProjectFile("not json")).toThrow(/not valid JSON/);
    expect(() => parseProjectFile("null")).toThrow(/empty or malformed/);
  });
});

describe("projectName", () => {
  it("takes the basename without the extension", () => {
    expect(projectName("D:\\clips\\my interview.sstproj")).toBe("my interview");
    expect(projectName("/home/a/b.sstproj")).toBe("b");
    expect(projectName("bare")).toBe("bare");
  });
});
