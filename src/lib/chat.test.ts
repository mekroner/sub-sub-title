import { describe, expect, it } from "vitest";

import type { ChatMessage, Cue, Section, Speaker } from "../types";
import {
  ATTACHMENT_ONLY_PROMPT,
  CHAT_MAX_TOKENS,
  CHAT_MAX_TOKENS_REASONING,
  CHAT_SYSTEM_PROMPT,
  anchorFor,
  attachmentLabel,
  buildAttachment,
  buildChatRequest,
  buildChatSystemPrompt,
  buildSelection,
  chatEffort,
  resolveChatModel,
  rewriteMessage,
  shortModelName,
  userContent,
} from "./chat";

const speakers: Speaker[] = [
  { id: "anna", name: "Anna", color: "#f00", voiceNotes: "clipped" },
  { id: "ben", name: "Ben", color: "#0f0" },
];

const cue = (id: string, start: number, end: number, text: string, speakerId: string | null): Cue => ({
  id,
  start,
  end,
  text,
  speakerId,
});

const CUES: Cue[] = [
  cue("a", 0, 2, "Where did the money go?", "ben"),
  cue("b", 2.5, 4, "I spent it.", "anna"),
  cue("c", 10, 12, "On what?", "ben"),
  cue("d", 12.5, 14, "Don't.", "anna"),
];

const SECTIONS: Section[] = [
  { id: "s1", start: 0, label: "Kitchen" },
  { id: "s2", start: 9, label: "Car", note: "Ben drives too fast." },
];

describe("anchorFor", () => {
  it("uses the selected cue's start", () => {
    expect(anchorFor(CUES, "c", 1)).toBe(10);
  });

  it("falls back to the playhead with nothing selected, or a stale selection", () => {
    expect(anchorFor(CUES, null, 5)).toBe(5);
    expect(anchorFor(CUES, "gone", 5)).toBe(5);
  });
});

describe("buildAttachment", () => {
  it("takes the last N lines up to and including the anchor cue", () => {
    const got = buildAttachment(CUES, [], speakers, 10, 2)!;
    expect(got.cueCount).toBe(2);
    expect(got.from).toBe(2.5);
    expect(got.to).toBe(12);
    expect(got.transcript).toContain("Anna says: I spent it.");
    expect(got.transcript).toContain("Ben says: On what?");
    expect(got.transcript).not.toContain("Don't.");
  });

  it("takes everything there is when N is larger than the script", () => {
    expect(buildAttachment(CUES, [], speakers, 100, 50)!.cueCount).toBe(4);
  });

  it("marks pauses and scene changes", () => {
    const got = buildAttachment(CUES, SECTIONS, speakers, 12.5, 4)!;
    expect(got.transcript).toContain("== Scene: Kitchen ==");
    expect(got.transcript).toContain("== Scene: Car ==");
    expect(got.transcript).toMatch(/\(pause 6\.0s\)/);
  });

  it("is null before the first line", () => {
    expect(buildAttachment(CUES, [], speakers, -1, 10)).toBeNull();
  });

  it("is labelled with its size and span", () => {
    expect(attachmentLabel(buildAttachment(CUES, [], speakers, 0, 5)!)).toMatch(/^1 line · /);
  });
});

describe("buildSelection", () => {
  it("is null with nothing selected, or only cues that are gone", () => {
    expect(buildSelection(CUES, [], speakers, new Set())).toBeNull();
    expect(buildSelection(CUES, [], speakers, new Set(["gone"]))).toBeNull();
  });

  it("takes every selected cue in time order, whatever order the cues are in", () => {
    const got = buildSelection([...CUES].reverse(), [], speakers, new Set(["c", "b", "a"]))!;
    expect(got.cueCount).toBe(3);
    expect(got.from).toBe(0);
    expect(got.to).toBe(12);
    expect(got.transcript.split("\n").filter((l) => l.startsWith("["))).toEqual([
      "[0:00.00] Ben says: Where did the money go?",
      "[0:02.50] Anna says: I spent it.",
      "[0:10.00] Ben says: On what?",
    ]);
  });

  it("keeps pauses and scene changes inside a run of neighbouring lines", () => {
    const got = buildSelection(CUES, SECTIONS, speakers, new Set(["b", "c"]))!;
    expect(got.transcript).toContain("== Scene: Car ==");
    expect(got.transcript).toMatch(/\(pause 6\.0s\)/);
    expect(got.transcript).not.toContain("…");
  });

  it("joins picks that are not neighbours with … instead of a pause", () => {
    const got = buildSelection(CUES, [], speakers, new Set(["a", "d"]))!;
    expect(got.transcript).toBe(
      "[0:00.00] Ben says: Where did the money go?\n…\n[0:12.50] Anna says: Don't.",
    );
  });
});

describe("buildChatSystemPrompt", () => {
  const base = { brief: "", beats: [], speakers: [], sections: [], anchor: 0 };

  it("is just the guidance for an empty project", () => {
    expect(buildChatSystemPrompt(base)).toBe(CHAT_SYSTEM_PROMPT);
  });

  it("adds the brief, beats, cast and current scene", () => {
    const got = buildChatSystemPrompt({
      brief: "A heist gone wrong.",
      beats: ["They meet", "  ", "It fails"],
      speakers,
      sections: SECTIONS,
      anchor: 11,
    });
    expect(got).toContain("## Project brief\nA heist gone wrong.");
    expect(got).toContain("1. They meet\n2. It fails");
    expect(got).toContain("- Anna\n  Voice: clipped");
    expect(got).toContain("## Current scene\nCar");
    expect(got).toContain("Note: Ben drives too fast.");
  });
});

describe("buildChatRequest", () => {
  const attachment = { cueCount: 1, from: 0, to: 2, transcript: "[0:00] Ben says: Hi" };

  it("puts an attachment ahead of the question", () => {
    const content = userContent({ text: "Too flat?", attachment });
    expect(content).toMatch(/^## Script excerpt \(.+\)\n\[0:00\] Ben says: Hi\n\nToo flat\?$/);
  });

  it("asks something when only an attachment was sent", () => {
    expect(userContent({ text: "  ", attachment })).toContain(ATTACHMENT_ONLY_PROMPT);
  });

  const selection = { cueCount: 1, from: 10, to: 12, transcript: "[0:10] Ben says: On what?" };

  it("puts the selected lines after the excerpt and ahead of the question", () => {
    expect(userContent({ text: "Better?", selection })).toMatch(
      /^## Selected lines \(.+\)\n\[0:10\] Ben says: On what\?\n\nBetter\?$/,
    );
    const both = userContent({ text: "Better?", attachment, selection });
    expect(both.indexOf("## Script excerpt")).toBe(0);
    expect(both.indexOf("## Selected lines")).toBeGreaterThan(0);
    expect(both.endsWith("\n\nBetter?")).toBe(true);
  });

  it("does not turn a selection alone into a question", () => {
    expect(userContent({ text: " ", selection })).toBe("");
  });

  it("sends each message's own selection", () => {
    const history: ChatMessage[] = [{ id: "1", role: "user", text: "this one?", selection }];
    const request = buildChatRequest("sys", history, { model: "m", temperature: 0.7 });
    expect(request.messages[1].content).toContain("## Selected lines");
  });

  it("drops failed and empty replies but keeps a partly stopped one", () => {
    const history: ChatMessage[] = [
      { id: "1", role: "user", text: "one" },
      { id: "2", role: "assistant", text: "Rate limited", status: "error" },
      { id: "3", role: "user", text: "two" },
      { id: "4", role: "assistant", text: "", status: "stopped" },
      { id: "5", role: "user", text: "three" },
      { id: "6", role: "assistant", text: "Maybe she", status: "stopped" },
      { id: "7", role: "user", text: "go on" },
    ];
    const request = buildChatRequest("sys", history, { model: "m", temperature: 0.7 });
    expect(request.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      "system:sys",
      "user:one",
      "user:two",
      "user:three",
      "assistant:Maybe she",
      "user:go on",
    ]);
    expect(request.model).toBe("m");
    expect(request.temperature).toBe(0.7);
    expect(request.maxTokens).toBe(CHAT_MAX_TOKENS);
    expect(request).not.toHaveProperty("reasoningEffort");
  });

  it("asks for reasoning, with room for it, when an effort is set", () => {
    const history: ChatMessage[] = [{ id: "1", role: "user", text: "one" }];
    const request = buildChatRequest("sys", history, { model: "m", temperature: 0.7, effort: "high" });
    expect(request.reasoningEffort).toBe("high");
    expect(request.maxTokens).toBe(CHAT_MAX_TOKENS_REASONING);
  });
});

describe("chat model and effort choices", () => {
  it("keeps a listed pick and otherwise falls back to the first model", () => {
    expect(resolveChatModel(["a/x", "b/y"], "b/y")).toBe("b/y");
    expect(resolveChatModel(["a/x", "b/y"], "gone/z")).toBe("a/x");
    expect(resolveChatModel(["a/x"], "")).toBe("a/x");
    expect(resolveChatModel([], "a/x")).toBe("");
  });

  it("treats an unset or unknown effort as the model's default", () => {
    expect(chatEffort("medium")).toBe("medium");
    expect(chatEffort("")).toBeNull();
    expect(chatEffort("max")).toBeNull();
  });

  it("drops the vendor from a model id", () => {
    expect(shortModelName("anthropic/claude-sonnet-4.5")).toBe("claude-sonnet-4.5");
    expect(shortModelName("plain")).toBe("plain");
  });
});

describe("rewriteMessage", () => {
  const attachment = { cueCount: 2, from: 0, to: 4, transcript: "[0:00] Ben says: Hi" };
  const history: ChatMessage[] = [
    { id: "1", role: "user", text: "one", attachment },
    { id: "2", role: "assistant", text: "reply one" },
    { id: "3", role: "user", text: "two" },
    { id: "4", role: "assistant", text: "reply two" },
    { id: "5", role: "user", text: "three" },
  ];

  it("keeps what came before and drops the reply and everything after", () => {
    const got = rewriteMessage(history, "3", { text: "  two, rethought ", attachment: null }, "new")!;
    expect(got.earlier.map((m) => m.id)).toEqual(["1", "2"]);
    expect(got.question).toEqual({ id: "new", role: "user", text: "two, rethought" });
  });

  it("can rewrite the first message, keeping or dropping its attachment", () => {
    const kept = rewriteMessage(history, "1", { text: "one again", attachment }, "n")!;
    expect(kept.earlier).toEqual([]);
    expect(kept.question.attachment).toBe(attachment);

    const dropped = rewriteMessage(history, "1", { text: "one again", attachment: null }, "n")!;
    expect(dropped.question).not.toHaveProperty("attachment");
  });

  it("keeps the selection the message was first sent with", () => {
    const selection = { cueCount: 1, from: 10, to: 12, transcript: "[0:10] Ben says: On what?" };
    const withSelection: ChatMessage[] = [{ id: "1", role: "user", text: "one", selection }];
    const got = rewriteMessage(withSelection, "1", { text: "one again", attachment: null }, "n")!;
    expect(got.question.selection).toBe(selection);
    expect(rewriteMessage(history, "3", { text: "x", attachment: null }, "n")!.question).not.toHaveProperty(
      "selection",
    );
  });

  it("refuses an empty edit, a reply, or a message that is gone", () => {
    expect(rewriteMessage(history, "3", { text: " ", attachment: null }, "n")).toBeNull();
    expect(rewriteMessage(history, "1", { text: "", attachment }, "n")).not.toBeNull();
    expect(rewriteMessage(history, "2", { text: "x", attachment: null }, "n")).toBeNull();
    expect(rewriteMessage(history, "gone", { text: "x", attachment: null }, "n")).toBeNull();
  });
});
