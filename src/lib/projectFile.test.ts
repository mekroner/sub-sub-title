import { describe, expect, it } from "vitest";

import {
  parseProjectFile,
  projectName,
  serializeProjectFile,
} from "./projectFile";
import type { Project } from "../types";
import { defaultVoiceover } from "./voiceover";

const project: Project = {
  videoPath: "D:/clips/interview.mp4",
  cues: [
    { id: "a", start: 0, end: 1.5, text: "Hello", speakerId: "s1" },
    { id: "b", start: 1.5, end: 3, text: "Goodbye", speakerId: null },
  ],
  speakers: [
    { id: "s1", name: "Ada", color: "#ff8800", voiceNotes: "dry", innerVoice: "frantic" },
  ],
  dictionary: ["Ada"],
  brief: "A heist that goes wrong in the first minute.",
  beats: ["Ada asks for the truth", "", "Ada leaves"],
  sections: [
    { id: "sec1", start: 0, label: "Cold open", note: "Ada already suspects" },
    { id: "sec2", start: 2, label: "Cut here" },
  ],
  timedBeats: [
    { id: "tb1", time: 0.5, text: "Ada asks" },
    { id: "tb2", time: 2.5, text: "She walks", by: "agent" },
  ],
  voiceover: {
    tracks: [
      {
        id: "original",
        kind: "original",
        name: "Original",
        gainDb: -6,
        muted: false,
        solo: false,
        automation: [{ time: 1, db: -12 }],
      },
      { id: "vo1", kind: "voice", name: "Ada VO", gainDb: 0, muted: true, solo: false, automation: [] },
    ],
    clips: [
      {
        id: "c1",
        trackId: "vo1",
        file: "D:/vo/line1.wav",
        name: "line1",
        start: 1.5,
        offset: 0.25,
        duration: 2,
        sourceDuration: 3,
        gainDb: 3,
        source: { cueIds: ["a", "b"], text: "Hello", voiceKey: "turbo||0.8" },
        takes: [
          { file: "D:/vo/old.wav", seed: 1, duration: 2.5 },
          {
            file: "D:/vo/line1.wav",
            seed: 2,
            duration: 3,
            marks: [[0, 1], [1.2, 2.9]],
            speech: [0.25, 2.25],
            check: { score: 0.82, rate: 14.5 },
            stretch: 1.1,
            original: "D:/vo/line1-spoken.wav",
          },
        ],
      },
    ],
    duck: { enabled: false, depthDb: -20, attack: 0.1, release: 0.5, bridge: 1 },
    unduckedCueIds: ["b"],
    cast: {
      s1: {
        preset: "male",
        engine: "standard",
        exaggeration: 0.9,
        cfgWeight: 0.3,
        temperature: 0.7,
        reference: "D:/vo/ada.wav",
        trackId: "vo1",
        referenceCueIds: ["a"],
        takesPerLine: 3,
      },
      "": { preset: "female", engine: "turbo", exaggeration: 0.5, cfgWeight: 0.5, temperature: 0.8 },
    },
    voicing: {
      a: { spoken: "[sigh] Hello.", direction: "tired" },
      b: { direction: "whispered" },
    },
    joins: { a: "join", b: "split" },
    pronunciations: { Siobhan: "shi-VAWN" },
  },
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
      brief: "",
      beats: [],
      sections: [],
      timedBeats: [],
      voiceover: defaultVoiceover(),
    });
  });

  it("gives a voice from before the built-in voices the female one", () => {
    const raw = JSON.stringify({
      videoPath: "v.mp4",
      cues: [],
      voiceover: {
        cast: {
          old: { engine: "turbo", exaggeration: 0.5, cfgWeight: 0.5, temperature: 0.8 },
          odd: { preset: "robot", engine: "turbo", exaggeration: 0.5, cfgWeight: 0.5, temperature: 0.8 },
          him: { preset: "male", engine: "turbo", exaggeration: 0.5, cfgWeight: 0.5, temperature: 0.8 },
        },
      },
    });
    const { cast } = parseProjectFile(raw).voiceover;
    expect(cast.old.preset).toBe("female");
    expect(cast.odd.preset).toBe("female");
    expect(cast.him.preset).toBe("male");
  });

  it("keeps only pronunciations with both a word and how it is said", () => {
    const raw = JSON.stringify({
      voiceover: { pronunciations: { " Siobhan ": " shi-VAWN ", GIF: "", "": "x", Ng: 7 } },
    });
    expect(parseProjectFile(raw).voiceover.pronunciations).toEqual({ Siobhan: "shi-VAWN" });
    expect(parseProjectFile(JSON.stringify({ voiceover: { pronunciations: {} } })).voiceover).not.toHaveProperty(
      "pronunciations",
    );
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

  it("sorts sections and drops the ones with no usable time", () => {
    const raw = JSON.stringify({
      sections: [
        { id: "b", start: 30, label: "Later" },
        { start: "nope", label: "No time" },
        { id: "a", start: 5, label: "Earlier" },
        { id: "c", start: 9 },
      ],
    });
    const { sections } = parseProjectFile(raw);
    expect(sections.map((s) => s.id)).toEqual(["a", "c", "b"]);
    // An unnamed flag is still a usable mark.
    expect(sections[1].label).toBe("");
  });

  it("sorts timed beats and drops the ones with no time or text", () => {
    const raw = JSON.stringify({
      timedBeats: [
        { id: "b", time: 30, text: "Later", by: "agent" },
        { id: "x", time: "nope", text: "No time" },
        { id: "y", time: 4, text: "   " },
        { id: "a", time: -2, text: "Earlier", by: "someone" },
      ],
    });
    expect(parseProjectFile(raw).timedBeats).toEqual([
      { id: "a", time: 0, text: "Earlier" },
      { id: "b", time: 30, text: "Later", by: "agent" },
    ]);
    // Files from before timed beats load with none.
    expect(parseProjectFile("{}").timedBeats).toEqual([]);
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
    brief: "",
    beats: [],
    sections: [],
    timedBeats: [],
    voiceover: defaultVoiceover(),
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
