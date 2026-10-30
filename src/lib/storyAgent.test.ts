import { describe, expect, it } from "vitest";

import type { AgentMessage, AgentReply, AgentStep, Cue, Speaker } from "../types";
import {
  MAX_STORY_LOOKS,
  MAX_STORY_QUESTIONS,
  STORY_TOOLS,
  buildStoryKickoff,
  buildStorySystemPrompt,
  createStoryAliases,
  describeStoryRun,
  executeStoryTool,
  parseStoryCommand,
  renderOutline,
  runStory,
  storyTools,
  type StoryEnv,
  type StoryState,
} from "./storyAgent";

const speakers: Speaker[] = [
  { id: "ada", name: "Ada", color: "#f00" },
  { id: "ben", name: "Ben", color: "#0f0" },
];

const cues: Cue[] = [
  { id: "l1", start: 2, end: 4, text: "Where is the money?", speakerId: "ada" },
  { id: "l2", start: 5, end: 7, text: "Gone.", speakerId: "ben" },
  { id: "l3", start: 65, end: 67, text: "I know what you did.", speakerId: "ada", mode: "thought" },
];

const STATE: StoryState = {
  sections: [
    { id: "kitchen", start: 0, label: "Kitchen" },
    { id: "street", start: 60, label: "Street", note: "Ada follows Ben" },
  ],
  beats: ["Ada finds out"],
  timedBeats: [
    { id: "mine", time: 5, text: "Ben lies" },
    { id: "theirs", time: 70, text: "Ada confronts him", by: "agent" },
  ],
};

const env: StoryEnv = { duration: 120, vision: false, speakers };

/** Aliases with the outline already read: kitchen s1, street s2, mine b1, theirs b2. */
function named() {
  const aliases = createStoryAliases();
  renderOutline(STATE, cues, env, aliases);
  return aliases;
}

const run = (name: string, args: object, state = STATE, aliases = named()) =>
  executeStoryTool(state, cues, env, aliases, name, JSON.stringify(args));

describe("parseStoryCommand", () => {
  it("reads the direction, and ignores other messages", () => {
    expect(parseStoryCommand("/story")).toEqual({ direction: "" });
    expect(parseStoryCommand("  /Story make it a revenge story ")).toEqual({ direction: "make it a revenge story" });
    expect(parseStoryCommand("/storyline")).toBeNull();
    expect(parseStoryCommand("/continue 30")).toBeNull();
  });
});

describe("renderOutline", () => {
  it("lists sections with spans, notes, line counts and owned beats", () => {
    const outline = renderOutline(STATE, cues, env, createStoryAliases());
    expect(outline).toContain('s1 [0:00.00–1:00.00] "Kitchen" — 2 lines of script');
    expect(outline).toContain("   Note: (none)");
    expect(outline).toContain("   b1 [0:05.00] Ben lies (writer's — fixed)");
    expect(outline).toContain('s2 [1:00.00–2:00.00] "Street" — 1 line of script');
    expect(outline).toContain("   Note: Ada follows Ben");
    expect(outline).toContain("   b2 [1:10.00] Ada confronts him (yours)");
    expect(outline).toContain("Overall story beats:\n1. Ada finds out");
  });
});

describe("executeStoryTool", () => {
  it("reads the script with ids and scene markers", () => {
    const { result, state } = run("read_cues", { from: 0, to: 70 });
    expect(state).toBe(STATE);
    expect(result).toContain("== Scene: Kitchen ==");
    expect(result).toContain("c1 [0:02.00–0:04.00] Ada says: Where is the money?");
    expect(result).toContain("c3 [1:05.00–1:07.00] Ada thinks: I know what you did.");
    expect(result).not.toContain("outside window");
  });

  it("names sections and writes their notes", () => {
    const outcome = run("set_section", { id: "s1", label: "The kitchen lie", note: "Ben wants Ada to drop it." });
    expect(outcome.state.sections[0]).toMatchObject({ label: "The kitchen lie", note: "Ben wants Ada to drop it." });
    expect(outcome.step).toMatchObject({ kind: "section", detail: "Ben wants Ada to drop it." });
    expect(run("set_section", { id: "s9", label: "x" }).result).toContain('There is no section "s9"');
    expect(run("set_section", { id: "s1" }).result).toContain("Give `label`, `note`, or both.");
  });

  it("adds a section only where none is flagged", () => {
    const added = run("add_section", { start: 30, label: "The car", note: "They drive in silence." });
    expect(added.state.sections.map((s) => s.label)).toEqual(["Kitchen", "The car", "Street"]);
    expect(run("add_section", { start: 61, label: "Too close" }).result).toContain("s2 already starts at 1:00.00");
    expect(run("add_section", { start: 130, label: "Past the end" }).result).toContain("not in the video");
  });

  it("adds its own beats, and refuses twins and times outside the video", () => {
    const added = run("add_beat", { time: 90, text: "Ben runs" });
    const beat = added.state.timedBeats.find((b) => b.text === "Ben runs");
    expect(beat).toMatchObject({ time: 90, by: "agent" });
    expect(added.result).toMatch(/^Added b3 \[1:30\.00\] Ben runs \(yours\)/);
    expect(run("add_beat", { time: 70.5, text: "ada confronts him" }).result).toContain("b2 already says that");
    expect(run("add_beat", { time: -1, text: "Before" }).result).toContain("not in the video");
  });

  it("revises and removes its own beats, but never the writer's", () => {
    const edited = run("edit_beat", { id: "b2", time: 75, text: "Ada confronts him at the car" });
    expect(edited.state.timedBeats.find((b) => b.id === "theirs")).toEqual({
      id: "theirs",
      time: 75,
      text: "Ada confronts him at the car",
      by: "agent",
    });
    expect(run("remove_beat", { id: "b2" }).state.timedBeats.map((b) => b.id)).toEqual(["mine"]);

    for (const name of ["edit_beat", "remove_beat"]) {
      const refused = run(name, { id: "b1", text: "Ben tells the truth" });
      expect(refused.state).toBe(STATE);
      expect(refused.result).toBe("Error: b1 is the writer's — a fixed point. Ask them if you think it should change.");
    }
  });

  it("replaces the overall beats within limits", () => {
    const outcome = run("set_story_beats", { beats: ["Setup", "  ", "Turn", "End"] });
    expect(outcome.state.beats).toEqual(["Setup", "Turn", "End"]);
    expect(outcome.step?.kind).toBe("outline");
    expect(run("set_story_beats", { beats: [] }).result).toContain("Give 1–12 beats");
  });

  it("ends on finish and reports unknown tools", () => {
    expect(run("finish", { summary: " A lie unravels. " }).finished).toBe("A lie unravels.");
    expect(run("add_cue", {}).result).toContain('There is no tool "add_cue"');
  });
});

describe("prompts and tools", () => {
  it("asks for an arc that fits the script and keeps the writer's beats", () => {
    const system = buildStorySystemPrompt({ brief: "A heist.", beats: [] }, env);
    expect(system).toContain("The existing dialogue is canon");
    expect(system).toContain("The writer's beats are fixed points");
    expect(system).toContain("Never write subtitle lines");
    expect(system).toContain("## Project brief\nA heist.");
    expect(system).not.toContain("## Looking at the video");
    expect(buildStorySystemPrompt({ brief: "", beats: [] }, { ...env, vision: true })).toContain("## Looking at the video");
  });

  it("opens with the outline, the script size and the direction", () => {
    const kickoff = buildStoryKickoff(STATE, cues, env, createStoryAliases(), "");
    expect(kickoff).toContain("## The outline now\nVideo length: 2:00.00");
    expect(kickoff).toContain("3 lines across 2 sections");
    expect(kickoff).toContain("## Direction from the writer\nNone — find the arc");
  });

  it("offers looking only with a vision model", () => {
    const names = (tools: unknown[]) => tools.map((t) => (t as { function: { name: string } }).function.name);
    expect(names(storyTools(false))).not.toContain("look_at_frame");
    expect(names(storyTools(true))).toContain("look_at_frame");
    expect(names(STORY_TOOLS)).toEqual(expect.arrayContaining(["ask_writer", "add_beat", "finish"]));
  });
});

describe("runStory", () => {
  const call = (id: string, name: string, args: object) => ({
    id,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  });
  const reply = (...calls: ReturnType<typeof call>[]): AgentReply => ({ role: "assistant", content: null, tool_calls: calls });

  it("applies outline edits, uses the larger budgets, and ends on finish", async () => {
    let state = STATE;
    const steps: AgentStep[] = [];
    const replies: AgentReply[] = [
      reply(call("a", "add_beat", { time: 100, text: "Ben is caught" })),
      reply(
        ...Array.from({ length: MAX_STORY_QUESTIONS + 1 }, (_, i) =>
          call(`q${i}`, "ask_writer", { question: `Q${i}?`, options: ["Yes", "No"] }),
        ),
      ),
      reply(call("f", "finish", { summary: "Caught in the lie." })),
    ];
    let asked = 0;
    const sent: AgentMessage[][] = [];
    const result = await runStory([], env, createStoryAliases(), {
      send: async (messages) => {
        sent.push([...messages]);
        return replies.shift()!;
      },
      getState: () => state,
      applyState: (next) => (state = next),
      getCues: () => cues,
      onStep: (step) => steps.push(step),
      isCurrent: () => true,
      askWriter: async () => {
        asked++;
        return { kind: "option", label: "Yes" };
      },
    });

    expect(result).toEqual({ ending: "finished", summary: "Caught in the lie." });
    expect(state.timedBeats.map((b) => b.text)).toContain("Ben is caught");
    expect(asked).toBe(MAX_STORY_QUESTIONS);
    expect(steps.filter((s) => s.kind === "ask")).toHaveLength(MAX_STORY_QUESTIONS);
    expect(steps[steps.length - 1]).toMatchObject({ kind: "error" });
    expect(MAX_STORY_LOOKS).toBe(12);
  });
});

describe("describeStoryRun", () => {
  it("counts the outline work and adds the summary", () => {
    const steps: AgentStep[] = [
      { kind: "read", label: "" },
      { kind: "add", label: "" },
      { kind: "add", label: "" },
      { kind: "section", label: "" },
      { kind: "outline", label: "" },
      { kind: "ask", label: "" },
    ];
    expect(describeStoryRun({ kind: "story", from: 0, to: 120, steps, summary: "A lie unravels." })).toBe(
      "Outline: added 2 beats, 1 section edit, rewrote the overall beats, asked 1 question. A lie unravels.",
    );
    expect(describeStoryRun({ kind: "story", from: 0, to: 120, steps: [] })).toBe("Outline: no changes.");
  });
});
