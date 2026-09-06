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
  dictionary: ["Ada"],
  beats: ["Ada asks for the truth", "", "Ada leaves"],
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
    expect(parsed).toEqual({
      videoPath: "",
      cues: [],
      speakers: [],
      dictionary: [],
      beats: [],
    });
  });

  it("keeps only usable words in the project dictionary", () => {
    const raw = JSON.stringify({ dictionary: ["Kaelen", "  ", 7, "  Arda  ", null] });
    expect(parseProjectFile(raw).dictionary).toEqual(["Kaelen", "Arda"]);
  });

  it("keeps the blank lines between story beats, but drops non-strings", () => {
    const raw = JSON.stringify({ beats: ["Act one", "", 7, null, "Act two"] });
    expect(parseProjectFile(raw).beats).toEqual(["Act one", "", "Act two"]);
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

describe("cue modes and speaker colours", () => {
  const withModes: Project = {
    videoPath: "D:/clips/interview.mp4",
    cues: [
      { id: "a", start: 1, end: 2, text: "Hello there.", speakerId: "mike" },
      {
        id: "b",
        start: 3,
        end: 4,
        text: "I'm so happy",
        speakerId: "mike",
        mode: "thought",
      },
    ],
    speakers: [
      { id: "mike", name: "Mike", color: "#4fc3f7", thinkingColor: "#334455" },
    ],
    dictionary: [],
    beats: [],
  };

  it("survives a save and load", () => {
    const back = parseProjectFile(serializeProjectFile(withModes));
    expect(back.cues[0].mode).toBeUndefined();
    expect(back.cues[1].mode).toBe("thought");
    expect(back.speakers[0].thinkingColor).toBe("#334455");
  });

  /** A file written before modes existed must come back byte-identical. */
  it("leaves the keys absent when a file has none", () => {
    const back = parseProjectFile(serializeProjectFile(project));
    expect(Object.keys(back.cues[0])).not.toContain("mode");
    expect(Object.keys(back.speakers[0])).not.toContain("thinkingColor");
  });

  it("drops a mode it does not recognise rather than trusting the file", () => {
    const raw = JSON.stringify({
      version: 1,
      cues: [{ id: "a", start: 1, end: 2, text: "Hi", speakerId: null, mode: "shouting" }],
      speakers: [],
    });
    expect(parseProjectFile(raw).cues[0].mode).toBeUndefined();
  });
});
