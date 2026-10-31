import { describe, expect, it } from "vitest";

import type { AgentReply, AgentStep, Cue, CueVoicing, Speaker, Voiceover } from "../types";
import { createAliases } from "./agent";
import {
  DIRECT_BATCH,
  buildDirectKickoff,
  buildDirectSystemPrompt,
  describeDirectRun,
  directTools,
  executeDirectTool,
  parseDirectCommand,
  renderScenes,
  renderVoiceLines,
  runDirect,
  type DirectEnv,
} from "./directAgent";
import { setVoice } from "./tts";
import { defaultVoiceover } from "./voiceover";

const speakers: Speaker[] = [
  { id: "ada", name: "Ada", color: "#f00", voiceNotes: "clipped, wary" },
  { id: "ben", name: "Ben", color: "#0f0" },
];

const cues: Cue[] = [
  { id: "l1", start: 2, end: 4, text: "Where is the money?", speakerId: "ada" },
  { id: "l2", start: 5, end: 7, text: "Gone, all of it.", speakerId: "ben" },
  { id: "l3", start: 65, end: 67, text: "I know what you did.", speakerId: "ada", mode: "thought" },
  { id: "l4", start: 67.2, end: 68, text: "", speakerId: "ada" },
];

const env: DirectEnv = {
  duration: 120,
  vision: false,
  speakers,
  sections: [
    { id: "kitchen", start: 0, label: "Kitchen", note: "Ada corners Ben" },
    { id: "street", start: 60, label: "Street" },
  ],
  timedBeats: [{ id: "b", time: 5, text: "Ben lies" }],
};

/** Ada on Turbo, Ben on Expressive. */
const VOICEOVER: Voiceover = setVoice(defaultVoiceover(), "ben", { engine: "standard" });

/** Aliases with the script already read: l1 c1, l2 c2, l3 c3, l4 c4. */
function named() {
  const aliases = createAliases();
  renderVoiceLines(cues, VOICEOVER, env, aliases);
  return aliases;
}

const run = (name: string, args: object, voiceover = VOICEOVER, aliases = named()) =>
  executeDirectTool(voiceover, cues, env, aliases, name, JSON.stringify(args));

const direct = (...lines: Array<{ id: string; direction: string; spoken?: string }>) => run("direct_lines", { lines });

const withVoicing = (voicing: Record<string, CueVoicing>): Voiceover => ({ ...VOICEOVER, voicing });

describe("parseDirectCommand", () => {
  it("reads the note, and ignores other messages", () => {
    expect(parseDirectCommand("/direct")).toEqual({ direction: "" });
    expect(parseDirectCommand(" /Direct understated, naturalistic ")).toEqual({ direction: "understated, naturalistic" });
    expect(parseDirectCommand("/directly")).toBeNull();
    expect(parseDirectCommand("direct this")).toBeNull();
  });
});

describe("renderVoiceLines", () => {
  it("shows each line's voice, its direction and script, and says from thinks", () => {
    const text = renderVoiceLines(
      cues.slice(0, 3),
      withVoicing({ l1: { direction: "cold", spoken: "[sigh] Where is the money?" } }),
      env,
      createAliases(),
    );
    expect(text).toContain("== Scene: Kitchen ==");
    expect(text).toContain("c1 [0:02.00–0:04.00] Ada says: Where is the money? (10 cps, turbo) — direction: cold · script: [sigh] Where is the money?");
    expect(text).toContain("c2 [0:05.00–0:07.00] Ben says: Gone, all of it. (8 cps, expressive)");
    expect(text).toContain("(pause 58.0s)");
    expect(text).toContain("Ada thinks: I know what you did.");
  });

  it("marks lines spoken together", () => {
    const split: Cue[] = [
      { id: "a", start: 1, end: 2, text: "I never meant", speakerId: "ada" },
      { id: "b", start: 2.1, end: 3, text: "to hurt you.", speakerId: "ada" },
    ];
    expect(renderVoiceLines(split, VOICEOVER, env, createAliases())).toContain("spoken as one line: c1+c2");
  });
});

describe("renderScenes", () => {
  it("lists each scene with its note, beats and how much is directed", () => {
    const text = renderScenes(cues, withVoicing({ l1: { direction: "cold" } }), env);
    expect(text).toContain('[0:00.00–1:00.00] "Kitchen" — 2 lines, 1 directed');
    expect(text).toContain("Note: Ada corners Ben");
    expect(text).toContain("[0:05.00] Ben lies");
    expect(text).toContain('"Street" — 1 lines, 0 directed');
  });
});

describe("direct_lines", () => {
  it("writes the note and script, and says what Turbo will speak", () => {
    const outcome = direct({ id: "c1", direction: "whispered, cold", spoken: "Where is... [sigh] the money?" });
    expect(outcome.voiceover.voicing.l1).toEqual({ direction: "whispered, cold", spoken: "Where is... [sigh] the money?" });
    expect(outcome.result).toBe("c1 → speaks: [whispering] Where is... [sigh] the money?");
    expect(outcome.step).toMatchObject({ kind: "direct", label: "🎙 Directed 1 line · “Kitchen”", count: 1 });
  });

  it("tells the model the intensity an Expressive note comes to", () => {
    expect(direct({ id: "c2", direction: "tired, flat" }).result).toBe("c2 → speaks: Gone, all of it. (intensity 0.3)");
    expect(direct({ id: "c2", direction: "evasive" }).result).toBe("c2 → speaks: Gone, all of it. (intensity 0.5, the voice's own)");
  });

  it("refuses tags Turbo does not know, and any tag on Expressive", () => {
    expect(direct({ id: "c1", direction: "cold", spoken: "[menacing] Where is the money?" }).result).toContain(
      "[menacing] is not a tag Turbo knows",
    );
    expect(direct({ id: "c1", direction: "cold", spoken: "[advertisement] Where is the money?" }).result).toContain("not a tag");
    expect(direct({ id: "c2", direction: "tired", spoken: "[sigh] Gone, all of it." }).result).toContain("reads tags aloud");
  });

  it("keeps the line's words, allowing a hesitation or a repeat", () => {
    expect(direct({ id: "c2", direction: "evasive", spoken: "Gone... gone, all of it." }).voiceover.voicing.l2?.spoken).toBe(
      "Gone... gone, all of it.",
    );
    expect(direct({ id: "c2", direction: "evasive", spoken: "It's all gone." }).result).toContain("keep the line's words");
    expect(direct({ id: "c2", direction: "evasive", spoken: "Gone, um, er, uh, well, so, all of it." }).result).toContain("adds 5 words");
  });

  it("applies the good lines of a batch and reports the bad ones", () => {
    const outcome = direct({ id: "c1", direction: "cold" }, { id: "c9", direction: "x" }, { id: "c4", direction: "a sigh" });
    expect(Object.keys(outcome.voiceover.voicing)).toEqual(["l1"]);
    expect(outcome.result).toContain('c9: there is no line "c9"');
    expect(outcome.result).toContain("c4: this line has no words to direct.");
    expect(outcome.step?.label).toContain("(2 refused)");
  });

  it("is an error when no line could be directed, or the batch is too big", () => {
    const none = direct({ id: "c1", direction: " " });
    expect(none.voiceover).toBe(VOICEOVER);
    expect(none.result).toContain("Error: no line was directed");
    const many = Array.from({ length: DIRECT_BATCH + 1 }, () => ({ id: "c1", direction: "cold" }));
    expect(direct(...many).result).toContain(`at most ${DIRECT_BATCH} lines`);
  });

  it("drops an old script when a new note comes without one", () => {
    const before = withVoicing({ l1: { direction: "angry", spoken: "[angry] Where is the money?" } });
    const outcome = run("direct_lines", { lines: [{ id: "c1", direction: "quiet" }] }, before);
    expect(outcome.voiceover.voicing.l1).toEqual({ direction: "quiet" });
  });
});

describe("finish", () => {
  it("is refused while lines with words have no direction, naming them", () => {
    const refused = run("finish", { summary: "Done." }, withVoicing({ l1: { direction: "cold" } }));
    expect(refused.result).toContain("2 lines have no direction yet: c2 [0:05.00–0:07.00], c3 [1:05.00–1:07.00]");
    expect(refused.finished).toBeUndefined();

    const all = withVoicing({ l1: { direction: "cold" }, l2: { direction: "evasive" }, l3: { direction: "close" } });
    expect(run("finish", { summary: "Cold and close." }, all).finished).toBe("Cold and close.");
  });
});

describe("prompts", () => {
  it("brings in the characters and the writer's note, and looking only with vision", () => {
    const system = buildDirectSystemPrompt({ brief: "A heist gone wrong", beats: [] }, env);
    expect(system).toContain("Voice: clipped, wary");
    expect(system).toContain("A heist gone wrong");
    expect(system).not.toContain("look_at_frame has");
    expect(buildDirectSystemPrompt({ brief: "", beats: [] }, { ...env, vision: true })).toContain("look_at_frame has");

    const kickoff = buildDirectKickoff(cues, VOICEOVER, env, "understated");
    expect(kickoff).toContain("3 lines to direct across 2:00.00");
    expect(kickoff).toContain("## Direction from the writer\nunderstated");
    expect(directTools(false).length + 1).toBe(directTools(true).length);
  });
});

describe("runDirect", () => {
  const call = (id: string, name: string, args: object) => ({
    id,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  });
  const reply = (...calls: ReturnType<typeof call>[]): AgentReply => ({ role: "assistant", content: null, tool_calls: calls });

  it("applies only the voicing, and ends on finish", async () => {
    let voiceover = VOICEOVER;
    const applied: Array<Record<string, CueVoicing>> = [];
    const steps: AgentStep[] = [];
    const replies: AgentReply[] = [
      reply(call("r", "read_cues", { from: 0, to: 120 })),
      reply(
        call("d", "direct_lines", {
          lines: [
            { id: "c1", direction: "cold" },
            { id: "c2", direction: "evasive" },
            { id: "c3", direction: "close, quiet" },
          ],
        }),
      ),
      reply(call("f", "finish", { summary: "Cold and close." })),
    ];
    const result = await runDirect([], env, createAliases(), {
      send: async () => replies.shift()!,
      getVoiceover: () => voiceover,
      applyVoicing: (voicing) => {
        applied.push(voicing);
        voiceover = { ...voiceover, voicing };
      },
      getCues: () => cues,
      onStep: (step) => steps.push(step),
      isCurrent: () => true,
    });

    expect(result).toEqual({ ending: "finished", summary: "Cold and close." });
    expect(applied).toHaveLength(1);
    expect(voiceover.voicing.l3).toEqual({ direction: "close, quiet" });
    expect(describeDirectRun({ kind: "direct", from: 0, to: 120, steps, summary: result.summary })).toBe(
      "Direction: directed 3 lines. Cold and close.",
    );
  });
});

describe("describeDirectRun", () => {
  it("counts lines across steps, questions and looks", () => {
    const steps: AgentStep[] = [
      { kind: "direct", label: "", count: 12 },
      { kind: "direct", label: "", count: 1 },
      { kind: "ask", label: "" },
      { kind: "look", label: "" },
      { kind: "look", label: "" },
    ];
    expect(describeDirectRun({ kind: "direct", from: 0, to: 60, steps })).toBe(
      "Direction: directed 13 lines, asked 1 question, looked at 2 frames.",
    );
    expect(describeDirectRun({ kind: "direct", from: 0, to: 60, steps: [] })).toBe("Direction: no changes.");
  });
});
