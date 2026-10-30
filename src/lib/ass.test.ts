import { describe, expect, it } from "vitest";
import { buildAss, hexToAssColor, toAssText } from "./ass";
import type { Cue, Settings, Speaker } from "../types";

const settings: Settings = {
  model: "x",
  temperature: 1,
  fillInstructions: "",
  fillGuidanceOverride: "",
  fillLinesBefore: 24,
  fillLinesAfter: 4,
  fillTakes: 3,
  fillLatitude: "open",
  ghostEnabled: true,
  ghostModel: "google/gemini-2.5-flash-lite",
  ghostDelayMs: 350,
  ghostLinesBefore: 10,
  ghostLinesAfter: 2,
  chatLinesBefore: 10,
  chatModels: ["x"],
  chatModel: "",
  chatEffort: "",
  fontName: "Arial",
  fontSize: 48,
  bold: false,
  outline: 2,
  outlineColor: "#000000",
  shadow: 0,
  shadowColor: "#000000",
  srtSpeakerColors: true,
  peaksResolution: 80,
  minGap: 0.04,
  maxCharsPerLine: 42,
  maxLines: 2,
  targetCps: 17,
  spellcheck: true,
  dialect: "american",
  whisperModel: "medium",
  whisperLanguage: "",
  whisperEnginePath: "",
};

const speakers: Speaker[] = [
  { id: "s1", name: "Alex", color: "#ff0000" },
  { id: "s2", name: "Sam Two", color: "#00ff00" },
];

const cues: Cue[] = [
  { id: "c1", start: 1, end: 2.5, text: "Hello", speakerId: "s1" },
  { id: "c2", start: 3, end: 4, text: "Two\nlines", speakerId: "s2" },
  { id: "c3", start: 5, end: 6, text: "Untagged", speakerId: null },
];

describe("hexToAssColor", () => {
  it("reverses RGB into BGR with an alpha byte", () => {
    expect(hexToAssColor("#ff0000")).toBe("&H000000FF");
    expect(hexToAssColor("#00ff00")).toBe("&H0000FF00");
    expect(hexToAssColor("#123456")).toBe("&H00563412");
  });

  it("falls back to white on a malformed value", () => {
    expect(hexToAssColor("nope")).toBe("&H00FFFFFF");
  });
});

describe("toAssText", () => {
  it("converts newlines to hard breaks", () => {
    expect(toAssText("a\nb")).toBe("a\\Nb");
  });

  it("maps italics to override tags", () => {
    expect(toAssText("<i>hi</i>")).toBe("{\\i1}hi{\\i0}");
  });

  it("escapes braces in the dialogue so they do not open a tag", () => {
    expect(toAssText("cost {50}")).toBe("cost \\{50\\}");
  });

  it("drops markup with no ASS equivalent", () => {
    expect(toAssText('<font color="red">hi</font>')).toBe("hi");
  });
});

describe("buildAss", () => {
  const output = buildAss(cues, speakers, { settings, width: 1920, height: 1080 });

  it("emits one style per speaker plus a default", () => {
    expect(output).toContain("Style: Default");
    expect(output).toContain("Style: Alex");
    expect(output).toContain("Style: Sam_Two");
  });

  it("uses the video dimensions for PlayRes", () => {
    expect(output).toContain("PlayResX: 1920");
    expect(output).toContain("PlayResY: 1080");
  });

  it("sets the style and actor per dialogue line", () => {
    expect(output).toContain("Dialogue: 0,0:00:01.00,0:00:02.50,Alex,Alex,0,0,0,,Hello");
    expect(output).toContain("Sam_Two,Sam Two,0,0,0,,Two\\Nlines");
  });

  it("falls back to Default for untagged cues", () => {
    expect(output).toContain("Default,,0,0,0,,Untagged");
  });

  it("gives colliding speaker names distinct style names", () => {
    const dupes: Speaker[] = [
      { id: "a", name: "Alex", color: "#ff0000" },
      { id: "b", name: "Alex", color: "#00ff00" },
    ];
    const out = buildAss([], dupes, { settings, width: 1920, height: 1080 });
    expect(out).toContain("Style: Alex,");
    expect(out).toContain("Style: Alex_2,");
  });
});

describe("thought cues", () => {
  const mike: Speaker[] = [
    { id: "m", name: "Mike", color: "#4fc3f7", thinkingColor: "#334455" },
  ];
  const build = (cue: Cue, who = mike) =>
    buildAss([cue], who, { settings, width: 1920, height: 1080 });

  const thought: Cue = {
    id: "t",
    start: 1,
    end: 2,
    text: "I'm so happy",
    speakerId: "m",
    mode: "thought",
  };

  it("gives each speaker a spoken and a thought style", () => {
    const out = build(thought);
    expect(out).toContain("Style: Mike,");
    expect(out).toContain("Style: Mike_thought,");
  });

  it("draws a thought in the thinking colour, in italics", () => {
    const line = build(thought)
      .split("\n")
      .find((l) => l.startsWith("Style: Mike_thought,"))!;
    const fields = line.split(",");
    // Name(0), Fontname, Fontsize, PrimaryColour(3), Secondary, Outline, Back, Bold, Italic(8)
    expect(fields[3]).toBe(hexToAssColor("#334455"));
    expect(fields[8]).toBe("-1");
  });

  it("falls back to a muted variant when the speaker picked no colour", () => {
    const bare: Speaker[] = [{ id: "m", name: "Mike", color: "#4fc3f7" }];
    const line = build(thought, bare)
      .split("\n")
      .find((l) => l.startsWith("Style: Mike_thought,"))!;
    expect(line.split(",")[3]).not.toBe(hexToAssColor("#4fc3f7"));
  });

  it("points a thought cue's event at the thought style", () => {
    const events = build(thought)
      .split("\n")
      .filter((l) => l.startsWith("Dialogue:"));
    expect(events[0].split(",")[3]).toBe("Mike_thought");
  });

  it("leaves a spoken cue on the speaking style", () => {
    const events = build({ ...thought, mode: undefined })
      .split("\n")
      .filter((l) => l.startsWith("Dialogue:"));
    expect(events[0].split(",")[3]).toBe("Mike");
  });

  it("uses the default thought style for a thought with no speaker", () => {
    const events = build({ ...thought, speakerId: null })
      .split("\n")
      .filter((l) => l.startsWith("Dialogue:"));
    expect(events[0].split(",")[3]).toBe("Default_thought");
  });

  it("never writes the asterisks into the burned-in text", () => {
    expect(build(thought)).not.toContain("*");
  });
});
