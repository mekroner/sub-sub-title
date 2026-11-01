import { describe, expect, it } from "vitest";

import type { CutSegment, Project, VoiceClip } from "../types";
import { defaultVoiceover } from "./voiceover";
import { addSource, placeSource, removeItem, sourceFromInfo, splitItem, startEditFromVideo, MAIN_TRACK_ID } from "./edit";
import { cutSegments, describeRecut, hasFlags, mapInterval, originalSegments, recutFlag, recutProject } from "./recut";

const seg = (start: number, duration: number, source: string, offset: number): CutSegment => ({
  start,
  duration,
  source,
  offset,
});

/** The original 10 s of a.mp4, straight through. */
const whole = [seg(0, 10, "a", 0)];

function project(cues: Array<[number, number]>, extra: Partial<Project> = {}): Project {
  return {
    videoPath: "a",
    cues: cues.map(([start, end], i) => ({ id: `c${i}`, start, end, text: `cue ${i}`, speakerId: null })),
    speakers: [],
    brief: "",
    beats: [],
    sections: [],
    timedBeats: [],
    voiceover: defaultVoiceover(),
    ...extra,
  };
}

const startsOf = (p: Project) => Object.fromEntries(p.cues.map((c) => [c.id, [c.start, c.end]]));

describe("mapInterval", () => {
  it("shifts everything after a head trim", () => {
    const trimmed = [seg(0, 8, "a", 2)];
    expect(mapInterval(whole, trimmed, 5, 6)).toEqual({ kind: "moved", delta: -2 });
    expect(mapInterval(whole, trimmed, 0.5, 1.5)).toEqual({ kind: "lost", delta: 0 });
    // Straddling the new head: moves with the part that is left.
    expect(mapInterval(whole, trimmed, 1.5, 3)).toEqual({ kind: "cut", delta: -2 });
  });

  it("follows clips that swap places", () => {
    const swapped = [seg(0, 5, "a", 5), seg(5, 5, "a", 0)];
    expect(mapInterval(whole, swapped, 1, 2)).toEqual({ kind: "moved", delta: 5 });
    expect(mapInterval(whole, swapped, 7, 8)).toEqual({ kind: "moved", delta: -5 });
  });

  it("goes with the larger part of a cue a cut runs through", () => {
    // 4–7 removed. 2–4.5 keeps 2 s before the cut: it stays. 6.5–8 keeps the
    // 1 s after it: it moves back with that.
    const cutOut = [seg(0, 4, "a", 0), seg(4, 3, "a", 7)];
    expect(mapInterval(whole, cutOut, 2, 4.5)).toEqual({ kind: "cut", delta: 0 });
    expect(mapInterval(whole, cutOut, 6.5, 8)).toEqual({ kind: "cut", delta: -3 });
  });

  it("picks the nearest copy of footage used twice", () => {
    const twice = [seg(0, 10, "a", 0), seg(10, 10, "a", 0)];
    expect(mapInterval(whole, twice, 3, 4)).toEqual({ kind: "moved", delta: 0 });
    const earlierRemoved = [seg(0, 2, "b", 0), seg(2, 10, "a", 0), seg(12, 10, "a", 0)];
    expect(mapInterval(whole, earlierRemoved, 3, 4)).toEqual({ kind: "moved", delta: 2 });
  });

  it("maps a moment, and lets something over black follow the footage before it", () => {
    const gapped = [seg(0, 4, "a", 0), seg(6, 4, "a", 4)];
    // Old video had a 2 s gap (4–6). The new one closes it up.
    const closed = [seg(0, 8, "a", 0)];
    expect(mapInterval(gapped, closed, 8, 8)).toEqual({ kind: "moved", delta: -2 });
    expect(mapInterval(gapped, closed, 4.5, 5.5)).toEqual({ kind: "moved", delta: 0 });
  });
});

describe("recutProject", () => {
  it("moves what is kept, parks what is not, and flags what a cut runs through", () => {
    // Cut 4–7 out of the original.
    const next = [seg(0, 4, "a", 0), seg(4, 3, "a", 7)];
    const before = project([
      [1, 2],
      [4.5, 5.5],
      [5.8, 6.8],
      [6.5, 7.8],
      [8.5, 9.5],
    ]);
    const { project: after, report } = recutProject(before, whole, next, 7);
    expect(startsOf(after)).toEqual({
      c0: [1, 2],
      c3: [3.5, 4.8],
      c4: [5.5, 6.5],
      // Parked after the end (7 + 1 s), in order, their spacing kept.
      c1: [8, 9],
      c2: [9.3, 10.3],
    });
    expect(report.moved).toBe(2);
    expect(report.cut.map((r) => r.id)).toEqual(["c3"]);
    expect(report.lost.map((r) => [r.id, r.at])).toEqual([
      ["c1", 8],
      ["c2", 9.3],
    ]);
    expect(hasFlags(report)).toBe(true);
    expect(describeRecut(report)).toBe("2 moved with the cut; 1 cut through; 2 in removed footage, parked after the end");
  });

  it("closes up long gaps between parked items", () => {
    const next = [seg(0, 1, "a", 0)];
    const before = project([
      [2, 3],
      [8, 9],
    ]);
    const { project: after } = recutProject(before, whole, next, 1);
    expect(startsOf(after)).toEqual({ c0: [2, 3], c1: [4, 5] });
  });

  it("moves clips, sections, beats and gain points too, and drops points in removed footage", () => {
    const next = [seg(0, 6, "a", 4)];
    const clip: VoiceClip = {
      id: "v1",
      trackId: "voice",
      file: "/vo/1.wav",
      name: "1.wav",
      start: 5,
      offset: 0,
      duration: 2,
      sourceDuration: 2,
      gainDb: 0,
    };
    const vo = defaultVoiceover();
    vo.tracks = vo.tracks.map((t) => ({ ...t, automation: [{ time: 1, db: -6 }, { time: 6, db: -3 }] }));
    vo.clips = [clip];
    const before = project([], {
      voiceover: vo,
      sections: [{ id: "s1", start: 5, label: "Scene" }],
      timedBeats: [{ id: "b1", time: 9, text: "End" }],
    });
    const { project: after, report } = recutProject(before, whole, next, 6);
    expect(after.voiceover.clips[0].start).toBe(1);
    expect(after.sections[0].start).toBe(1);
    expect(after.timedBeats[0].time).toBe(5);
    expect(after.voiceover.tracks[0].automation).toEqual([{ time: 2, db: -3 }]);
    expect(report.droppedPoints).toBe(1);
    expect(report.moved).toBe(3);
  });

  it("flags only what the writer has not since moved", () => {
    const next = [seg(0, 4, "a", 0)];
    const { project: after, report } = recutProject(project([[6, 7]]), whole, next, 4);
    const cue = after.cues[0];
    expect(recutFlag(report, "cue", cue.id, cue.start)).toBe("lost");
    expect(recutFlag(report, "cue", cue.id, cue.start + 0.5)).toBeUndefined();
  });
});

describe("segments from an edit", () => {
  const info = { duration: 10, hasAudio: true, hasVideo: true, width: 640, height: 360, fps: 25, videoCodec: "h264", audioCodec: "aac" };

  it("reads the original video straight through, and the cut from the main track", () => {
    let edit = startEditFromVideo("/v/a.mp4", info);
    expect(originalSegments(edit, "/v/a.mp4")).toEqual([seg(0, 10, "/v/a.mp4", 0)]);
    expect(originalSegments(edit, "/v/other.mp4")).toBeNull();
    // Split at 4 and 7, take the middle out.
    const first = edit.items[0].id;
    const a = splitItem(edit, first, 4);
    const b = splitItem(a.edit, a.id!, 7);
    edit = removeItem(b.edit, a.id!);
    const image = addSource(edit, sourceFromInfo("/v/card.png", { ...info, duration: 0 }, "image"));
    edit = placeSource(image.edit, image.id, MAIN_TRACK_ID, 12, "card").edit;
    expect(cutSegments(edit)).toEqual([
      seg(0, 4, "/v/a.mp4", 0),
      seg(7, 3, "/v/a.mp4", 7),
      seg(12, 3, "item:card", 0),
    ]);
  });
});
