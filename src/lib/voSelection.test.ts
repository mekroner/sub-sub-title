import { describe, expect, it } from "vitest";

import { EMPTY_SELECTION, applySelection, pruneSelection, selectionSize } from "./voSelection";
import { addClips, addTrack, defaultVoiceover, moveClipsBy, newClip, voiceTracks } from "./voiceover";

const cue = (id: string) => ({ kind: "cue" as const, id });
const clip = (id: string) => ({ kind: "clip" as const, id });

describe("applySelection", () => {
  it("replaces, adds and toggles, across cues and clips", () => {
    let s = applySelection(EMPTY_SELECTION, { items: [cue("a")], mode: "replace" });
    expect([...s.cues]).toEqual(["a"]);
    expect(s.primary).toEqual(cue("a"));

    s = applySelection(s, { items: [clip("x")], mode: "add" });
    expect(selectionSize(s)).toBe(2);
    expect(s.primary).toEqual(clip("x"));

    s = applySelection(s, { items: [cue("a")], mode: "toggle" });
    expect([...s.cues]).toEqual([]);
    // Toggling the primary out leaves the last remaining choice primary.
    expect(s.primary).toEqual(clip("x"));

    s = applySelection(s, { items: [clip("x")], mode: "toggle" });
    expect(selectionSize(s)).toBe(0);
    expect(s.primary).toBeNull();
  });

  it("takes an explicit primary, and an empty replace clears", () => {
    const s = applySelection(EMPTY_SELECTION, {
      items: [cue("a"), cue("b")],
      mode: "replace",
      primary: cue("a"),
    });
    expect(s.primary).toEqual(cue("a"));
    expect(applySelection(s, { items: [], mode: "replace" })).toEqual(EMPTY_SELECTION);
  });
});

describe("pruneSelection", () => {
  it("drops what no longer exists, and keeps the object when nothing did", () => {
    const s = applySelection(EMPTY_SELECTION, { items: [cue("a"), clip("x")], mode: "replace" });
    expect(pruneSelection(s, new Set(["a"]), new Set(["x"]))).toBe(s);
    const pruned = pruneSelection(s, new Set(["a"]), new Set());
    expect([...pruned.clips]).toEqual([]);
    // The primary was the clip, which went.
    expect(pruned.primary).toBeNull();
  });
});

describe("moveClipsBy", () => {
  it("moves a block of clips together, stopping at zero", () => {
    let vo = addTrack(defaultVoiceover());
    const track = voiceTracks(vo)[0].id;
    const a = newClip(track, "a.wav", 2, 1);
    const b = newClip(track, "b.wav", 5, 1);
    const c = newClip(track, "c.wav", 9, 1);
    vo = addClips(vo, [a, b, c]);
    const ids = new Set([a.id, b.id]);

    const later = moveClipsBy(vo, ids, 1.5);
    expect(later.delta).toBe(1.5);
    expect(later.voiceover.clips.map((x) => x.start)).toEqual([3.5, 6.5, 9]);

    const tooEarly = moveClipsBy(vo, ids, -10);
    expect(tooEarly.delta).toBe(-2);
    expect(tooEarly.voiceover.clips.map((x) => x.start)).toEqual([0, 3, 9]);

    expect(moveClipsBy(vo, new Set(), 3)).toEqual({ voiceover: vo, delta: 0 });
  });
});
