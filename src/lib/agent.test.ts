import { describe, expect, it } from "vitest";

import type { AgentMessage, AgentReply, AgentRun, AgentStep, Cue, Speaker, WriterAnswer, WriterQuestion } from "../types";
import {
  AGENT_MAX_TOKENS,
  AGENT_MAX_TOKENS_REASONING,
  AGENT_TOOLS,
  DEFAULT_CONTINUE_SECONDS,
  MAX_CONTINUE_SECONDS,
  MAX_LOOKS,
  MAX_QUESTIONS,
  agentTools,
  agentWindow,
  aliasFor,
  buildAgentRequest,
  buildContinueKickoff,
  buildContinueSystemPrompt,
  createAliases,
  createLooks,
  describeRun,
  executeTool,
  parseContinueCommand,
  prepareLook,
  prepareQuestion,
  runAgent,
  type AgentEnv,
  type AskWriter,
  type DescribeFrame,
} from "./agent";

const speakers: Speaker[] = [
  { id: "anna", name: "Anna", color: "#f00", voiceNotes: "clipped" },
  { id: "ben", name: "Ben", color: "#0f0" },
];

const cue = (id: string, start: number, end: number, text: string, speakerId: string | null = "anna"): Cue => ({
  id,
  start,
  end,
  text,
  speakerId,
});

const CUES: Cue[] = [
  cue("a", 0, 2, "Where did the money go?", "ben"),
  cue("b", 2.5, 4, "I spent it."),
  cue("c", 12, 13.5, "On what?", "ben"),
  cue("d", 25, 27, "Later.", "anna"),
];

const env: AgentEnv = {
  window: { start: 10, end: 20 },
  duration: 60,
  vision: false,
  speakers,
  sections: [],
  targetCps: 17,
  minGap: 0.1,
  maxCharsPerLine: 42,
  maxLines: 2,
};

/** Aliases with every fixture cue named in order: a → c1, b → c2, … */
function named() {
  const aliases = createAliases();
  for (const c of CUES) aliasFor(aliases, c.id);
  return aliases;
}

const run = (name: string, args: object, cues = CUES, aliases = named()) =>
  executeTool(cues, env, aliases, name, JSON.stringify(args));

describe("parseContinueCommand", () => {
  it("reads seconds and direction, with defaults", () => {
    expect(parseContinueCommand("/continue")).toEqual({ seconds: DEFAULT_CONTINUE_SECONDS, direction: "" });
    expect(parseContinueCommand("/continue 45")).toEqual({ seconds: 45, direction: "" });
    expect(parseContinueCommand("/continue 45s Ben admits it")).toEqual({ seconds: 45, direction: "Ben admits it" });
    expect(parseContinueCommand("  /Continue make it tense\nand short")).toEqual({
      seconds: DEFAULT_CONTINUE_SECONDS,
      direction: "make it tense\nand short",
    });
  });

  it("clamps the window and ignores other messages", () => {
    expect(parseContinueCommand("/continue 9999")?.seconds).toBe(MAX_CONTINUE_SECONDS);
    expect(parseContinueCommand("/continue 1")?.seconds).toBe(5);
    expect(parseContinueCommand("continue 30")).toBeNull();
    expect(parseContinueCommand("/continued")).toBeNull();
    expect(parseContinueCommand("what about /continue?")).toBeNull();
  });
});

describe("agentWindow", () => {
  it("runs from the playhead and stops at the end of the video", () => {
    expect(agentWindow(10, 30, 100)).toEqual({ start: 10, end: 40 });
    expect(agentWindow(90, 30, 100)).toEqual({ start: 90, end: 100 });
    expect(agentWindow(90, 30, 0)).toEqual({ start: 90, end: 120 });
  });
});

describe("executeTool", () => {
  it("reads lines anywhere, with ids, speed and whether they can be changed", () => {
    const { result, cues } = run("read_cues", { from: 0, to: 15 });
    expect(cues).toBe(CUES);
    expect(result).toContain("c1 [0:00.00–0:02.00] Ben says: Where did the money go? (12 cps, outside window)");
    expect(result).toContain("(pause 8.0s)");
    expect(result).toContain("c3 [0:12.00–0:13.50] Ben says: On what? (5 cps)");
    expect(result).not.toContain("Later.");
  });

  it("adds a line timed to its text when no end is given", () => {
    const outcome = run("add_cue", { start: 14, speaker: "anna", mode: "thinks", text: "*He knows.*" });
    const added = outcome.cues.find((c) => c.id === outcome.created)!;
    expect(added).toMatchObject({ start: 14, end: 15, text: "He knows.", speakerId: "anna", mode: "thought" });
    expect(outcome.result).toMatch(/^Added c5 \[0:14\.00–0:15\.00\] Anna thinks: He knows\./);
    expect(outcome.step?.kind).toBe("add");
  });

  it("cuts a default end to the room before the next line", () => {
    const outcome = run("add_cue", {
      start: 10,
      speaker: "Ben",
      mode: "says",
      text: "A line long enough to need more than two seconds on screen.",
    });
    const added = outcome.cues.find((c) => c.id === outcome.created)!;
    expect(added.end).toBeCloseTo(11.9);
    expect(outcome.result).toContain("too fast");
  });

  it("refuses lines outside the window, overlapping, or by unknown speakers", () => {
    const outside = run("add_cue", { start: 19, end: 21, speaker: "Ben", mode: "says", text: "Hi" });
    expect(outside.result).toMatch(/^Error: .*outside your window 0:10\.00–0:20\.00/);
    expect(outside.cues).toBe(CUES);
    expect(outside.step?.kind).toBe("error");

    const clash = run("add_cue", { start: 13, end: 14, speaker: "Ben", mode: "says", text: "Hi" });
    expect(clash.result).toContain("overlaps c3 [0:12.00–0:13.50]");

    const stranger = run("add_cue", { start: 15, speaker: "Bob", mode: "says", text: "Hi" });
    expect(stranger.result).toContain('Unknown speaker "Bob"; known: Anna, Ben.');
  });

  it("edits, moves and deletes lines inside the window only", () => {
    const edited = run("edit_cue", { id: "c3", text: "On what, exactly?", mode: "thinks" });
    expect(edited.cues.find((c) => c.id === "c")).toMatchObject({ text: "On what, exactly?", mode: "thought" });

    const moved = run("move_cue", { id: "c3", start: 15 });
    expect(moved.cues.find((c) => c.id === "c")).toMatchObject({ start: 15, end: 16.5 });

    const deleted = run("delete_cue", { id: "c3" });
    expect(deleted.cues.map((c) => c.id)).toEqual(["a", "b", "d"]);

    expect(run("edit_cue", { id: "c1", text: "No" }).result).toContain("c1 is outside your window");
    expect(run("delete_cue", { id: "c9" }).result).toContain('There is no line "c9"');
    expect(run("move_cue", { id: "c3", start: 19 }).result).toContain("outside your window");
  });

  it("treats a cue the run added like any other", () => {
    const aliases = named();
    const added = run("add_cue", { start: 15, speaker: "Ben", mode: "says", text: "Fine." }, CUES, aliases);
    const alias = aliases.byId.get(added.created!)!;
    expect(alias).toBe("c5");
    const removed = run("delete_cue", { id: alias }, added.cues, aliases);
    expect(removed.cues).toHaveLength(CUES.length);
  });

  it("reports bad arguments and unknown tools instead of throwing", () => {
    expect(executeTool(CUES, env, named(), "add_cue", "{nope").result).toContain("not a JSON object");
    expect(run("add_cue", { speaker: "Ben", mode: "says", text: "Hi" }).result).toContain("`start` is required");
    expect(run("teleport", {}).result).toContain('There is no tool "teleport"');
  });

  it("ends the run on finish", () => {
    const outcome = run("finish", { summary: "  Ben  stalls. " });
    expect(outcome.finished).toBe("Ben stalls.");
    expect(outcome.step).toBeNull();
  });
});

describe("prompts", () => {
  it("states the limits and the project", () => {
    const system = buildContinueSystemPrompt({ brief: "A heist gone wrong.", beats: [] }, env);
    expect(system).toContain("Aim for 17 characters per second");
    expect(system).toContain("## Project brief\nA heist gone wrong.");
    expect(system).toContain("- Anna\n  Voice: clipped");
  });

  it("opens with the window, the script around it and the direction", () => {
    const kickoff = buildContinueKickoff(CUES, env, createAliases(), "Ben pushes", 1);
    expect(kickoff).toContain("## Your window\n0:10.00–0:20.00 — 10.00 s to 20.00 s, 10.0 s long.");
    expect(kickoff).toContain("## Script before your window\nc1 [0:02.50–0:04.00] Anna says: I spent it.");
    expect(kickoff).toContain("## Already in your window\nc2 [0:12.00–0:13.50] Ben says: On what?");
    expect(kickoff).toContain("## Right after your window (lead into this)\nc3 [0:25.00–0:27.00]");
    expect(kickoff).toContain("## Direction from the writer\nBen pushes");
  });

  it("builds a request with the tools and the effort's budget", () => {
    const messages: AgentMessage[] = [{ role: "user", content: "go" }];
    expect(buildAgentRequest(messages, { model: "m", temperature: 0.7 })).toEqual({
      model: "m",
      temperature: 0.7,
      maxTokens: AGENT_MAX_TOKENS,
      messages,
      tools: AGENT_TOOLS,
    });
    const reasoning = buildAgentRequest(messages, { model: "m", temperature: 0.7, effort: "high" });
    expect(reasoning).toMatchObject({ maxTokens: AGENT_MAX_TOKENS_REASONING, reasoningEffort: "high" });
  });
});

describe("runAgent", () => {
  const call = (id: string, name: string, args: object) => ({
    id,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  });

  function harness(replies: AgentReply[]) {
    let cues = CUES;
    const steps: AgentStep[] = [];
    const sent: AgentMessage[][] = [];
    let current = true;
    return {
      steps,
      sent,
      cues: () => cues,
      stop: () => (current = false),
      deps: {
        send: async (messages: AgentMessage[]) => {
          sent.push([...messages]);
          const reply = replies.shift();
          if (!reply) throw new Error("no more replies");
          return reply;
        },
        getCues: () => cues,
        applyCues: (next: Cue[]) => (cues = next),
        onStep: (step: AgentStep) => steps.push(step),
        isCurrent: () => current,
      },
    };
  }

  it("runs tools, feeds back their results, and stops at finish", async () => {
    const h = harness([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          call("t1", "add_cue", { start: 15, speaker: "Ben", mode: "says", text: "Fine." }),
          call("t2", "delete_cue", { id: "c99" }),
        ],
      },
      { role: "assistant", content: null, tool_calls: [call("t3", "finish", { summary: "Ben gives in." })] },
    ]);
    const result = await runAgent([{ role: "user", content: "go" }], env, createAliases(), h.deps);

    expect(result.ending).toBe("finished");
    expect(result.summary).toBe("Ben gives in.");
    expect(result.created).toHaveLength(1);
    expect(h.cues()).toHaveLength(CUES.length + 1);
    expect(h.steps.map((s) => s.kind)).toEqual(["add", "error"]);

    const second = h.sent[1];
    expect(second.slice(-2)).toEqual([
      { role: "tool", tool_call_id: "t1", content: expect.stringMatching(/^Added c1 /) },
      { role: "tool", tool_call_id: "t2", content: expect.stringMatching(/^Error: There is no line/) },
    ]);
  });

  it("ends when the model answers without a tool call", async () => {
    const h = harness([{ role: "assistant", content: "Nothing to add here." }]);
    const result = await runAgent([], env, createAliases(), h.deps);
    expect(result).toEqual({ ending: "finished", summary: "Nothing to add here.", created: [] });
  });

  const seeing: AgentEnv = { ...env, vision: true };
  const looking = (id: string, time: number, question?: string): AgentReply => ({
    role: "assistant",
    content: null,
    tool_calls: [call(id, "look_at_frame", question ? { time, question } : { time })],
  });
  const finishing: AgentReply = {
    role: "assistant",
    content: null,
    tool_calls: [call("f", "finish", { summary: "Done." })],
  };

  it("hands a frame description back as a fallible hint", async () => {
    const asked: Array<[number, string | undefined]> = [];
    const describeFrame: DescribeFrame = async (time, question) => {
      asked.push([time, question]);
      return { ok: true, description: "Two people at a kitchen table, one crying." };
    };
    const h = harness([looking("l1", 12.34, "Who is crying?"), looking("l2", 12.3), finishing]);
    await runAgent([], seeing, createAliases(), { ...h.deps, describeFrame });

    // The second look rounds to the same tenth, so it costs no second call.
    expect(asked).toEqual([[12.34, "Who is crying?"]]);
    expect(h.steps).toEqual([
      { kind: "look", label: "👁 Looked at 0:12.34", detail: "Two people at a kitchen table, one crying." },
      { kind: "look", label: "👁 Looked at 0:12.30", detail: "Two people at a kitchen table, one crying." },
    ]);
    const result = h.sent[1][h.sent[1].length - 1]!;
    expect(result).toMatchObject({ role: "tool", tool_call_id: "l1" });
    expect((result as { content: string }).content).toMatch(
      /^Vision model's description of the frame at 0:12\.34 \(a hint: it can be wrong, and the script and the writer's notes win\):\nTwo people/,
    );
  });

  it("carries on when the vision model fails or refuses", async () => {
    const describeFrame: DescribeFrame = async () => ({ ok: false, error: "No endpoints found" });
    const h = harness([looking("l1", 12), finishing]);
    const result = await runAgent([], seeing, createAliases(), { ...h.deps, describeFrame });

    expect(result.ending).toBe("finished");
    expect(h.steps[0]).toEqual({ kind: "error", label: "look_at_frame: No endpoints found" });
    expect((h.sent[1][h.sent[1].length - 1] as { content: string }).content).toBe(
      "Error: the vision model could not describe the frame (No endpoints found). Carry on from the script.",
    );
  });

  it("stops the run when a look is cancelled", async () => {
    const describeFrame: DescribeFrame = () => Promise.reject("cancelled");
    const h = harness([looking("l1", 12)]);
    await expect(runAgent([], seeing, createAliases(), { ...h.deps, describeFrame })).rejects.toBe("cancelled");
  });

  it("refuses a look without vision", async () => {
    const h = harness([looking("l1", 12), finishing]);
    await runAgent([], env, createAliases(), h.deps);
    expect(h.steps[0].kind).toBe("error");
  });

  const direction = {
    question: "Where should this scene go?",
    options: [{ label: "Ben confesses", description: "He has been lying all along." }, { label: "Anna walks out" }],
  };
  const asking = (id: string): AgentReply => ({
    role: "assistant",
    content: null,
    tool_calls: [call(id, "ask_writer", direction)],
  });
  const lastResult = (h: { sent: AgentMessage[][] }, turn: number) =>
    (h.sent[turn][h.sent[turn].length - 1] as { content: string }).content;

  it("puts a question to the writer and passes on each kind of answer", async () => {
    const answers: WriterAnswer[] = [
      { kind: "option", label: "Ben confesses" },
      { kind: "own", text: "Neither —  they  laugh it off" },
    ];
    const seen: WriterQuestion[] = [];
    const askWriter: AskWriter = async (question) => {
      seen.push(question);
      return answers.shift()!;
    };
    const h = harness([asking("q1"), asking("q2"), finishing]);
    const result = await runAgent([], env, createAliases(), { ...h.deps, askWriter });

    expect(result.ending).toBe("finished");
    expect(seen[0]).toEqual(direction);
    expect(lastResult(h, 1)).toBe('The writer chose: "Ben confesses".');
    expect(lastResult(h, 2)).toBe('The writer answered in their own words: "Neither — they laugh it off"');
    expect(h.steps).toEqual([
      { kind: "ask", label: "❓ Where should this scene go?", detail: "→ Ben confesses" },
      { kind: "ask", label: "❓ Where should this scene go?", detail: "→ “Neither — they laugh it off”" },
    ]);
  });

  it("tells the model to decide when the writer skips, or when nobody can answer", async () => {
    const skipped = harness([asking("q1"), finishing]);
    await runAgent([], env, createAliases(), { ...skipped.deps, askWriter: async () => ({ kind: "skipped" }) });
    expect(lastResult(skipped, 1)).toMatch(/^The writer skipped the question — decide yourself/);
    expect(skipped.steps[0].detail).toBe("→ skipped: left to the model");

    const alone = harness([asking("q1"), finishing]);
    expect((await runAgent([], env, createAliases(), alone.deps)).ending).toBe("finished");
    expect(alone.steps[0].kind).toBe("error");
  });

  it("stops the run when the writer stops it mid-question, and keeps to the budget", async () => {
    const stopped = harness([asking("q1")]);
    const askWriter: AskWriter = () => Promise.reject("cancelled");
    await expect(runAgent([], env, createAliases(), { ...stopped.deps, askWriter })).rejects.toBe("cancelled");

    let calls = 0;
    const counting: AskWriter = async () => {
      calls++;
      return { kind: "skipped" };
    };
    const greedy = harness([asking("q1"), asking("q2"), asking("q3"), finishing]);
    await runAgent([], env, createAliases(), { ...greedy.deps, askWriter: counting });
    expect(calls).toBe(MAX_QUESTIONS);
    expect(lastResult(greedy, 3)).toContain(`You have asked ${MAX_QUESTIONS} questions`);
  });

  it("gives up after the turn limit, and stops once replaced", async () => {
    const reading = () => ({
      role: "assistant" as const,
      content: null,
      tool_calls: [call("r", "read_cues", { from: 0, to: 10 })],
    });
    const limited = harness([reading(), reading(), reading()]);
    expect((await runAgent([], env, createAliases(), limited.deps, 2)).ending).toBe("limit");

    const replaced = harness([reading(), reading()]);
    replaced.stop();
    expect((await runAgent([], env, createAliases(), replaced.deps)).ending).toBe("abandoned");
    expect(replaced.sent).toHaveLength(0);
  });
});

describe("looking at frames", () => {
  const seeing: AgentEnv = { ...env, vision: true };

  it("is offered only with a vision model", () => {
    const names = (tools: unknown[]) => tools.map((t) => (t as { function: { name: string } }).function.name);
    expect(names(agentTools(false))).not.toContain("look_at_frame");
    expect(names(agentTools(true))).toContain("look_at_frame");
    expect(buildContinueSystemPrompt({ brief: "", beats: [] }, env)).not.toContain("## Looking at the video");
    expect(buildContinueSystemPrompt({ brief: "", beats: [] }, seeing)).toContain("Treat every description as a hint");
  });

  it("checks the time and keeps to the budget", () => {
    const looks = createLooks();
    expect(prepareLook(seeing, looks, '{"time": 75}')).toMatchObject({ kind: "refused" });
    expect(prepareLook(seeing, looks, '{"time": -1}')).toMatchObject({ kind: "refused" });
    expect(prepareLook(seeing, looks, "nope")).toMatchObject({ kind: "refused" });
    expect(prepareLook(env, looks, '{"time": 5}')).toMatchObject({ kind: "refused" });

    looks.used = MAX_LOOKS;
    const spent = prepareLook(seeing, looks, '{"time": 5}');
    expect(spent).toMatchObject({ kind: "refused", message: expect.stringContaining("all 6 looks") });

    looks.seen.set("5.0", "A hallway.");
    expect(prepareLook(seeing, looks, '{"time": 5.04}')).toEqual({ kind: "seen", time: 5.04, description: "A hallway." });
  });
});

describe("prepareQuestion", () => {
  const args = (value: object) => JSON.stringify(value);

  it("accepts two to four distinct options, as objects or plain strings", () => {
    expect(prepareQuestion(0, args({ question: " Tone? ", options: ["Dark", { label: "Light", description: "  Warm. " }] }))).toEqual({
      ok: true,
      question: { question: "Tone?", options: [{ label: "Dark" }, { label: "Light", description: "Warm." }] },
    });
  });

  it("refuses a malformed question", () => {
    const bad = (value: object | string) =>
      prepareQuestion(0, typeof value === "string" ? value : args(value));
    expect(bad({ question: "", options: ["a", "b"] })).toMatchObject({ ok: false, message: "`question` is empty." });
    expect(bad({ question: "Tone?", options: ["only one"] })).toMatchObject({ ok: false });
    expect(bad({ question: "Tone?", options: ["a", "b", "c", "d", "e"] })).toMatchObject({ ok: false });
    expect(bad({ question: "Tone?", options: ["Dark", "dark"] })).toMatchObject({
      ok: false,
      message: "Each option needs its own label.",
    });
    expect(bad("{nope")).toMatchObject({ ok: false });
    expect(prepareQuestion(MAX_QUESTIONS, args({ question: "Tone?", options: ["a", "b"] }))).toMatchObject({ ok: false });
  });

  it("is meant for direction, not for approving lines", () => {
    const system = buildContinueSystemPrompt({ brief: "", beats: [] }, env);
    expect(system).toContain("never ask about specific lines or wording");
    expect(system).not.toContain("Do not ask questions");
    const names = AGENT_TOOLS.map((t) => t.function.name);
    expect(names).toContain("ask_writer");
  });
});

describe("describeRun", () => {
  it("counts what changed and adds the summary", () => {
    const runInfo: AgentRun = {
      from: 80,
      to: 110,
      steps: [
        { kind: "read", label: "" },
        { kind: "add", label: "" },
        { kind: "add", label: "" },
        { kind: "edit", label: "" },
        { kind: "error", label: "" },
      ],
      summary: "Ben admits it.",
    };
    expect(describeRun(runInfo)).toBe("Continued 1:20.00–1:50.00: added 2, edited 1. Ben admits it.");
    expect(describeRun({ from: 0, to: 5, steps: [] })).toBe("Continued 0:00.00–0:05.00: no changes.");
    expect(describeRun({ from: 0, to: 5, steps: [{ kind: "look", label: "" }, { kind: "add", label: "" }] })).toBe(
      "Continued 0:00.00–0:05.00: added 1, looked at 1 frame.",
    );
    expect(describeRun({ from: 0, to: 5, steps: [{ kind: "ask", label: "" }] })).toBe(
      "Continued 0:00.00–0:05.00: asked 1 question.",
    );
  });
});
