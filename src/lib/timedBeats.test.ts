import { describe, expect, it } from "vitest";

import type { Section, TimedBeat } from "../types";
import { addBeat, beatsBetween, editBeat, groupBySection, newBeat, removeBeat } from "./timedBeats";

const beat = (id: string, time: number, text: string, by?: "agent"): TimedBeat => ({
  id,
  time,
  text,
  ...(by ? { by } : {}),
});

const BEATS = [beat("a", 5, "Ada arrives"), beat("b", 40, "The money is gone", "agent"), beat("c", 90, "She leaves")];

const sections: Section[] = [
  { id: "s2", start: 60, label: "Street" },
  { id: "s1", start: 30, label: "Kitchen" },
];

describe("timed beats", () => {
  it("adds in time order and removes by id", () => {
    const added = addBeat(BEATS, beat("d", 20, "A knock"));
    expect(added.map((b) => b.id)).toEqual(["a", "d", "b", "c"]);
    expect(removeBeat(added, "d")).toEqual(BEATS);
    expect(removeBeat(BEATS, "nope")).toBe(BEATS);
    expect(newBeat(-3, "x", "agent")).toMatchObject({ time: 0, text: "x", by: "agent" });
  });

  it("makes an agent's beat the writer's when the writer edits it", () => {
    const edited = editBeat(BEATS, "b", { text: "The money is gone — all of it" });
    expect(edited.find((b) => b.id === "b")).toEqual(beat("b", 40, "The money is gone — all of it"));

    const byAgent = editBeat(BEATS, "b", { time: 95 }, "agent");
    expect(byAgent.map((b) => b.id)).toEqual(["a", "c", "b"]);
    expect(byAgent.find((b) => b.id === "b")?.by).toBe("agent");

    expect(editBeat(BEATS, "a", { text: "Ada arrives" })).toBe(BEATS);
  });

  it("finds the beats in a stretch", () => {
    expect(beatsBetween(BEATS, 5, 90).map((b) => b.id)).toEqual(["a", "b"]);
  });

  it("groups beats by section span, with a group for any before the first", () => {
    const groups = groupBySection(sections, BEATS, 120);
    expect(groups.map((g) => [g.section?.id ?? null, g.start, g.end, g.beats.map((b) => b.id)])).toEqual([
      [null, 0, 30, ["a"]],
      ["s1", 30, 60, ["b"]],
      ["s2", 60, 120, ["c"]],
    ]);

    const tidy = groupBySection(sections, [beat("b", 40, "x")], 120);
    expect(tidy.map((g) => g.section?.id)).toEqual(["s1", "s2"]);

    const none = groupBySection([], BEATS, 120);
    expect(none).toHaveLength(1);
    expect(none[0].beats).toHaveLength(3);
  });
});
