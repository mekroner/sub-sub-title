import { describe, expect, it } from "vitest";

import type { Cue, Section, Speaker } from "../types";
import {
  DEFAULT_FILL_GUIDANCE,
  buildSlots,
  buildSystemPrompt,
  buildTranscript,
  buildUserPrompt,
  continueWindow,
  layoutContinuation,
  parseFillReply,
  renderTranscript,
  resolveLine,
  slotCharLimit,
} from "./fill";
import type { FillTarget, PromptInput } from "./fill";

const LIMITS = { targetCps: 17, maxCharsPerLine: 42, maxLines: 2 };
const GAP = 0.04;

const speakers: Speaker[] = [
  { id: "anna", name: "Anna", color: "#f00", voiceNotes: "clipped", innerVoice: "anxious" },
  { id: "ben", name: "Ben", color: "#0f0" },
];

const cue = (
  id: string,
  start: number,
  end: number,
  text: string,
  speakerId: string | null = null,
  thought = false,
): Cue => ({ id, start, end, text, speakerId, ...(thought ? { mode: "thought" as const } : {}) });

const CUES: Cue[] = [
  cue("a", 0, 2, "You're late again.", "anna"),
  cue("b", 2.5, 4, "Don't say the bar.", "ben", true),
  cue("c", 4.5, 6, "", "ben"),
  cue("d", 10, 12, "I said I was sorry.", "ben"),
];

const SECTIONS: Section[] = [
  { id: "s1", start: 0, label: "Kitchen", note: "Anna knows where he was" },
  { id: "s2", start: 9, label: "Hallway" },
];

function fillSetup(target: FillTarget = { kind: "fill", cueIds: ["c"] }) {
  const window = target.kind === "continue" ? continueWindow(CUES, target.after, 60, GAP) : null;
  const slots = buildSlots(target, CUES, [], LIMITS, window, GAP);
  const transcript = buildTranscript(CUES, slots, SECTIONS, 10, 10, window);
  return { slots, transcript };
}

function promptInput(overrides: Partial<PromptInput> = {}): PromptInput {
  const target: FillTarget = { kind: "fill", cueIds: ["c"] };
  const { slots, transcript } = fillSetup(target);
  return {
    target,
    slots,
    transcript,
    speakers,
    brief: "A marriage coming apart over one lie.",
    beats: ["Ben lies about the bar", "", "Anna leaves"],
    direction: "he tries charm and it fails",
    latitude: "open",
    drafts: "complete",
    takes: 3,
    guidanceOverride: "",
    instructions: "",
    ...overrides,
  };
}

describe("slotCharLimit", () => {
  it("is what can be read in the time on screen", () => {
    expect(slotCharLimit(1.5, LIMITS)).toBe(25);
  });

  it("never exceeds what the line limits hold", () => {
    expect(slotCharLimit(30, LIMITS)).toBe(84);
    expect(slotCharLimit(Infinity, LIMITS)).toBe(84);
  });
});

describe("continueWindow", () => {
  it("runs from after the cue under the moment to the next cue", () => {
    const window = continueWindow(CUES, 5, 60, GAP);
    expect(window.start).toBeCloseTo(6.04, 5);
    expect(window.end).toBeCloseTo(9.96, 5);
  });

  it("is open-ended past the last cue when there is no media length", () => {
    expect(continueWindow(CUES, 13, 0, GAP).end).toBe(Infinity);
  });
});

describe("buildSlots", () => {
  it("takes speaker, mode and draft from the cues being filled", () => {
    const slots = buildSlots({ kind: "fill", cueIds: ["b", "c"] }, CUES, [], LIMITS, null, GAP);
    expect(slots.map((s) => [s.number, s.speakerId, s.mode, s.draft])).toEqual([
      [1, "ben", "thought", "Don't say the bar."],
      [2, "ben", "spoken", ""],
    ]);
  });

  it("leaves new lines to the model and shares the window between them", () => {
    const window = { start: 0, end: 4 };
    const slots = buildSlots({ kind: "continue", after: 0, count: 2 }, CUES, [], LIMITS, window, 0);
    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({ cueId: null, speakerId: null, mode: "choose", maxChars: 34 });
  });
});

describe("buildTranscript", () => {
  it("marks speech, thought, the slot, pauses and scene changes", () => {
    const { transcript } = fillSetup();
    const text = renderTranscript(transcript, speakers);
    expect(text).toBe(
      [
        "== Scene: Kitchen ==",
        "[0:00.00] Anna says: You're late again.",
        "[0:02.50] Ben thinks: Don't say the bar.",
        "[0:04.50] «SLOT 1» | speaker: Ben | mode: says | on screen 1.5s | max 25 characters",
        "(pause 4.0s)",
        "== Scene: Hallway ==",
        "[0:10.00] Ben says: I said I was sorry.",
      ].join("\n"),
    );
  });

  it("limits the lines before and after the slots", () => {
    const slots = buildSlots({ kind: "fill", cueIds: ["b"] }, CUES, [], LIMITS, null, GAP);
    const items = buildTranscript(CUES, slots, [], 0, 1, null);
    expect(items.filter((i) => i.kind === "line").map((i) => i.kind === "line" && i.cue.id)).toEqual([
      "c",
    ]);
  });

  it("places new lines after everything before the window", () => {
    const { transcript } = fillSetup({ kind: "continue", after: 5, count: 2 });
    const text = renderTranscript(transcript, speakers);
    const lines = text.split("\n");
    const firstSlot = lines.findIndex((l) => l.startsWith("«SLOT 1»"));
    expect(firstSlot).toBeGreaterThan(lines.indexOf("[0:02.50] Ben thinks: Don't say the bar."));
    expect(lines[firstSlot]).toContain("new line");
    expect(lines[firstSlot]).toContain("speaker: your choice | mode: your choice");
    expect(lines[firstSlot + 1]).toMatch(/^«SLOT 2»/);
  });
});

describe("buildSystemPrompt", () => {
  it("uses the built-in guidance and always carries the conventions", () => {
    const system = buildSystemPrompt(promptInput());
    expect(system.startsWith(DEFAULT_FILL_GUIDANCE)).toBe(true);
    expect(system).toContain("Only the thinker knows a thought");
    expect(system).toContain("Give exactly 3 takes");
  });

  it("lets an override replace the guidance but not the conventions", () => {
    const system = buildSystemPrompt(promptInput({ guidanceOverride: "Write like Pinter." }));
    expect(system.startsWith("Write like Pinter.")).toBe(true);
    expect(system).not.toContain("No stock dialogue");
    expect(system).toContain("Reply format");
  });

  it("adds the writer's standing instructions", () => {
    const system = buildSystemPrompt(promptInput({ instructions: "Norwegian, Bergen dialect." }));
    expect(system).toContain("Standing instructions from the writer");
    expect(system).toContain("Norwegian, Bergen dialect.");
  });
});

describe("buildUserPrompt", () => {
  it("carries brief, beats, cast with inner voices, scene notes, and direction last", () => {
    const user = buildUserPrompt(promptInput());
    expect(user).toContain("## Project brief\nA marriage coming apart over one lie.");
    expect(user).toContain("1. Ben lies about the bar\n2. Anna leaves");
    expect(user).toContain("- Anna\n  Voice: clipped\n  Inner voice: anxious");
    expect(user).toContain("- Kitchen: Anna knows where he was");
    expect(user).toContain("Fill slot 1.");
    expect(user.trimEnd().endsWith("he tries charm and it fails")).toBe(true);
  });

  it("mentions drafts only when a slot has one", () => {
    expect(buildUserPrompt(promptInput())).not.toContain("draft");
    const target: FillTarget = { kind: "fill", cueIds: ["b"] };
    const { slots, transcript } = fillSetup(target);
    const user = buildUserPrompt(promptInput({ target, slots, transcript, drafts: "rewrite" }));
    expect(user).toContain("rewrite it freely");
  });

  it("asks for the next lines in continue mode", () => {
    const target: FillTarget = { kind: "continue", after: 5, count: 3 };
    const { slots, transcript } = fillSetup(target);
    expect(buildUserPrompt(promptInput({ target, slots, transcript }))).toContain(
      "Write the next 3 lines (slots 1–3)",
    );
  });
});

describe("parseFillReply", () => {
  it("reads takes, modes and approaches", () => {
    const takes = parseFillReply(
      JSON.stringify({
        takes: [
          {
            approach: "charm",
            lines: [
              { slot: 1, speaker: "Ben", mode: "says", text: "Flowers?" },
              { slot: 2, speaker: "Anna", mode: "thinks", text: "*Liar.*" },
            ],
          },
        ],
      }),
      2,
    );
    expect(takes).toEqual([
      {
        approach: "charm",
        lines: [
          { speakerName: "Ben", mode: "spoken", text: "Flowers?" },
          { speakerName: "Anna", mode: "thought", text: "Liar." },
        ],
      },
    ]);
  });

  it("tolerates a fence, a preamble, and a bare list of lines", () => {
    const fenced = '```json\n{"takes":[{"lines":[{"slot":1,"text":"One."}]}]}\n```';
    expect(parseFillReply(fenced, 1)[0].lines[0]?.text).toBe("One.");

    const chatty = 'Here you go:\n[{"slot": 1, "text": "\\"Two.\\""}]\nEnjoy!';
    expect(parseFillReply(chatty, 1)[0].lines[0]?.text).toBe("Two.");
  });

  it("drops slots out of range and falls back to position without a number", () => {
    const takes = parseFillReply(
      '{"takes":[{"lines":[{"text":"first"},{"slot":9,"text":"nowhere"},{"text":"third"}]}]}',
      3,
    );
    expect(takes[0].lines.map((l) => l?.text ?? null)).toEqual(["first", null, "third"]);
  });

  it("throws when nothing usable came back", () => {
    expect(() => parseFillReply("I can't help with that.", 2)).toThrow();
  });
});

describe("resolveLine", () => {
  it("keeps what the slot fixed and takes the model's choice where it was open", () => {
    const [slot] = buildSlots({ kind: "continue", after: 0, count: 1 }, CUES, [], LIMITS, null, GAP);
    expect(resolveLine(slot, { speakerName: "anna", mode: "thought", text: "x" }, speakers)).toEqual({
      speakerId: "anna",
      mode: "thought",
    });

    const fixed = { ...slot, speakerId: "ben", mode: "spoken" as const };
    expect(resolveLine(fixed, { speakerName: "Anna", mode: "thought", text: "x" }, speakers)).toEqual({
      speakerId: "ben",
      mode: "spoken",
    });
  });
});

describe("layoutContinuation", () => {
  it("times each line to its text and lays them end to end", () => {
    const slots = layoutContinuation(["x".repeat(34), "Hi."], { start: 10, end: 60 }, 17, 0.1)!;
    expect(slots[0]).toEqual({ start: 10, end: 12 });
    expect(slots[1].start).toBeCloseTo(12.1, 5);
    expect(slots[1].end).toBeCloseTo(13.1, 5);
  });

  it("shrinks every line alike to fit a short window", () => {
    const slots = layoutContinuation(["a".repeat(34), "b".repeat(34)], { start: 0, end: 2.1 }, 17, 0.1)!;
    expect(slots[0].end - slots[0].start).toBeCloseTo(1, 5);
    expect(slots[1].end).toBeCloseTo(2.1, 5);
  });

  it("refuses when there is no real room", () => {
    expect(layoutContinuation(["one", "two"], { start: 0, end: 0.1 }, 17, 0.04)).toBeNull();
  });
});
