import { describe, expect, it } from "vitest";

import type { Voiceover } from "../types";
import { parseProjectFile } from "./projectFile";
import {
  DEFAULT_DUCK,
  MAX_VOICE_TRACKS,
  MIN_CLIP_SECONDS,
  ORIGINAL_TRACK_ID,
  addClips,
  addTrack,
  dbToGain,
  defaultVoiceover,
  isAudible,
  isCueDucked,
  patchDuck,
  toggleCueDuck,
  moveClip,
  newClip,
  overlappingClips,
  patchTrack,
  removeTrack,
  snapTime,
  trimClipEnd,
  trimClipStart,
  voiceTracks,
} from "./voiceover";

function withTrack(): { vo: Voiceover; trackId: string } {
  const vo = addTrack(defaultVoiceover());
  return { vo, trackId: voiceTracks(vo)[0].id };
}

describe("tracks", () => {
  it("starts with the original track alone", () => {
    const vo = defaultVoiceover();
    expect(vo.tracks).toHaveLength(1);
    expect(vo.tracks[0].id).toBe(ORIGINAL_TRACK_ID);
  });

  it("stops adding voice tracks at the limit", () => {
    let vo = defaultVoiceover();
    for (let i = 0; i < MAX_VOICE_TRACKS + 2; i++) vo = addTrack(vo);
    expect(voiceTracks(vo)).toHaveLength(MAX_VOICE_TRACKS);
  });

  it("does not reuse a name still in use", () => {
    let vo = addTrack(addTrack(defaultVoiceover()));
    vo = removeTrack(vo, voiceTracks(vo)[0].id);
    vo = addTrack(vo);
    expect(voiceTracks(vo).map((t) => t.name).sort()).toEqual(["VO 1", "VO 2"]);
  });

  it("removes a track's clips with it, and never the original", () => {
    const { vo, trackId } = withTrack();
    const withClip = addClips(vo, [newClip(trackId, "a.wav", 0, 1)]);
    expect(removeTrack(withClip, trackId).clips).toEqual([]);
    expect(removeTrack(withClip, ORIGINAL_TRACK_ID)).toBe(withClip);
  });

  it("returns the same object for a patch that changes nothing", () => {
    const vo = defaultVoiceover();
    expect(patchTrack(vo, ORIGINAL_TRACK_ID, { muted: false })).toBe(vo);
  });

  it("silences every unsoloed track while anything is soloed", () => {
    const { vo, trackId } = withTrack();
    const soloed = patchTrack(vo, trackId, { solo: true });
    const original = soloed.tracks[0];
    const voice = soloed.tracks[1];
    expect(isAudible(soloed, original)).toBe(false);
    expect(isAudible(soloed, voice)).toBe(true);
  });
});

describe("clips", () => {
  it("only lands clips on voice tracks", () => {
    const { vo } = withTrack();
    expect(addClips(vo, [newClip(ORIGINAL_TRACK_ID, "a.wav", 0, 1)])).toBe(vo);
  });

  it("moves between voice tracks but not onto the original", () => {
    let vo = addTrack(addTrack(defaultVoiceover()));
    const [first, second] = voiceTracks(vo);
    const clip = newClip(first.id, "a.wav", 2, 1);
    vo = addClips(vo, [clip]);
    expect(moveClip(vo, clip.id, 3, second.id).clips[0]).toMatchObject({ start: 3, trackId: second.id });
    expect(moveClip(vo, clip.id, 3, ORIGINAL_TRACK_ID).clips[0].trackId).toBe(first.id);
    expect(moveClip(vo, clip.id, -5).clips[0].start).toBe(0);
  });

  it("trims the head without moving the tail, within the file", () => {
    const { vo, trackId } = withTrack();
    const clip = newClip(trackId, "a.wav", 10, 4);
    const trimmed = trimClipStart(addClips(vo, [clip]), clip.id, 11).clips[0];
    expect(trimmed).toMatchObject({ start: 11, offset: 1, duration: 3 });

    // Dragging the head back out can only reveal what the file has.
    const restored = trimClipStart(addClips(vo, [trimmed]), clip.id, 5).clips[0];
    expect(restored).toMatchObject({ start: 10, offset: 0, duration: 4 });
  });

  it("never trims a clip to nothing", () => {
    const { vo, trackId } = withTrack();
    const clip = newClip(trackId, "a.wav", 10, 4);
    const base = addClips(vo, [clip]);
    expect(trimClipEnd(base, clip.id, 0).clips[0].duration).toBe(MIN_CLIP_SECONDS);
    expect(trimClipStart(base, clip.id, 99).clips[0].duration).toBeCloseTo(MIN_CLIP_SECONDS);
    expect(trimClipEnd(base, clip.id, 99).clips[0].duration).toBe(4);
  });

  it("finds clips that play over another on their track, and only those", () => {
    let vo = addTrack(addTrack(defaultVoiceover()));
    const [first, second] = voiceTracks(vo);
    const a = newClip(first.id, "a.wav", 0, 3);
    const b = newClip(first.id, "b.wav", 2, 2); // into a
    const c = newClip(first.id, "c.wav", 4, 1); // touches b's end
    const d = newClip(first.id, "d.wav", 4.99, 1); // a crossfade's worth into c
    const e = newClip(second.id, "e.wav", 0, 10); // another track
    const f = newClip(first.id, "f.wav", 8, 1);
    const g = newClip(first.id, "g.wav", 7, 0.5); // inside nothing, before f
    vo = addClips(vo, [a, b, c, d, e, f, g]);
    expect([...overlappingClips(vo)].sort()).toEqual([a.id, b.id].sort());

    // A long clip reaching past several later ones collides with each.
    const long = newClip(second.id, "long.wav", 20, 10);
    const late = newClip(second.id, "late.wav", 25, 1);
    vo = addClips(vo, [long, late]);
    expect(overlappingClips(vo).has(late.id)).toBe(true);
    expect(overlappingClips(vo).has(long.id)).toBe(true);
  });
});

describe("helpers", () => {
  it("treats the floor as silence", () => {
    expect(dbToGain(-60)).toBe(0);
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(6)).toBeCloseTo(1.995, 3);
  });

  it("snaps to the nearest candidate within tolerance", () => {
    expect(snapTime(1.02, [1, 2], 0.05)).toBe(1);
    expect(snapTime(1.2, [1, 2], 0.05)).toBe(1.2);
  });
});

describe("reading voiceover from a project file", () => {
  it("gives an older file the original track alone", () => {
    const project = parseProjectFile(JSON.stringify({ videoPath: "a.mp4", cues: [] }));
    expect(project.voiceover).toEqual(defaultVoiceover());
  });

  it("repairs a hand-edited mix rather than rejecting it", () => {
    const project = parseProjectFile(
      JSON.stringify({
        voiceover: {
          tracks: [
            { id: "v1", kind: "voice", name: "A" },
            { id: "v1", kind: "voice", name: "duplicate" },
            { id: "x", kind: "bogus" },
          ],
          clips: [
            { id: "c1", trackId: "v1", file: "a.wav", start: 1, offset: 0, duration: 9, sourceDuration: 2 },
            { id: "c2", trackId: "gone", file: "b.wav", start: 1, duration: 1, sourceDuration: 1 },
            { id: "c3", trackId: "v1", start: 1, duration: 1, sourceDuration: 1 },
          ],
        },
      }),
    );
    const { tracks, clips } = project.voiceover;
    expect(tracks.map((t) => t.id)).toEqual([ORIGINAL_TRACK_ID, "v1"]);
    expect(clips.map((c) => c.id)).toEqual(["c1"]);
    // A duration longer than the file is cut to what the file holds.
    expect(clips[0].duration).toBe(2);
  });
});

describe("duck settings", () => {
  it("clamps what it is given and keeps the same object for no change", () => {
    const vo = defaultVoiceover();
    expect(patchDuck(vo, { depthDb: 6 }).duck.depthDb).toBe(0);
    expect(patchDuck(vo, { attack: -1 }).duck.attack).toBe(0);
    expect(patchDuck(vo, { release: Number.NaN }).duck.release).toBe(DEFAULT_DUCK.release);
    expect(patchDuck(vo, { depthDb: DEFAULT_DUCK.depthDb })).toBe(vo);
  });

  it("toggles a cue's duck off and on", () => {
    const off = toggleCueDuck(defaultVoiceover(), "c1");
    expect(isCueDucked(off, "c1")).toBe(false);
    expect(isCueDucked(off, "c2")).toBe(true);
    expect(isCueDucked(toggleCueDuck(off, "c1"), "c1")).toBe(true);
  });

  it("reads duck settings from a file, defaulting what is missing or bad", () => {
    const project = parseProjectFile(
      JSON.stringify({
        voiceover: { duck: { enabled: false, depthDb: "deep", release: -4 }, unduckedCueIds: ["x", "x", 3] },
      }),
    );
    expect(project.voiceover.duck).toEqual({
      ...DEFAULT_DUCK,
      enabled: false,
      release: 0,
    });
    expect(project.voiceover.unduckedCueIds).toEqual(["x"]);
  });
});

describe("reading lines from older project files", () => {
  it("turns a clip's single cue into a one-cue line, and keeps only whole marks", () => {
    const project = parseProjectFile(
      JSON.stringify({
        voiceover: {
          tracks: [{ id: "v1", kind: "voice", name: "A" }],
          clips: [
            {
              id: "c1",
              trackId: "v1",
              file: "a.wav",
              start: 1,
              offset: 0,
              duration: 2,
              sourceDuration: 2,
              source: { cueId: "cue-a", text: "Hi", voiceKey: "k" },
              takes: [{ file: "a.wav", seed: 1, duration: 2, marks: [[0, 1], ["x", 2]] }],
            },
          ],
          joins: { "cue-a": "join", "cue-b": "maybe" },
        },
      }),
    );
    const clip = project.voiceover.clips[0];
    expect(clip.source?.cueIds).toEqual(["cue-a"]);
    // A partly broken list would pair marks with the wrong cues.
    expect(clip.takes?.[0]).not.toHaveProperty("marks");
    expect(project.voiceover.joins).toEqual({ "cue-a": "join" });
  });
});
