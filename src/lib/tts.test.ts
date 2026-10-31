import { describe, expect, it } from "vitest";

import type { Cue } from "../types";
import {
  DEFAULT_VOICE,
  NO_SPEAKER,
  fitCuesToLines,
  isClipStale,
  lineState,
  overrun,
  pendingCues,
  placeTake,
  referenceSegments,
  renderLine,
  removeTake,
  selectTake,
  setVoice,
  setVoicing,
  speechText,
  takePath,
  trackForVoice,
  voiceFor,
  voiceKey,
} from "./tts";
import { addTrack, defaultVoiceover, moveClip, voiceTracks } from "./voiceover";

const cue = (id: string, start: number, end: number, text: string, speakerId: string | null = "s1"): Cue => ({
  id,
  start,
  end,
  text,
  speakerId,
});

describe("voices", () => {
  it("falls back to the default voice and stores patches per speaker", () => {
    const vo = setVoice(defaultVoiceover(), "s1", { reference: "a.wav" });
    expect(voiceFor(vo, "s1").reference).toBe("a.wav");
    expect(voiceFor(vo, "s2")).toEqual(DEFAULT_VOICE);
    expect(voiceFor(setVoice(vo, "s1", { reference: undefined }), "s1")).not.toHaveProperty("reference");
  });

  it("keys a voice on what changes the sound, not on its track", () => {
    const base = { ...DEFAULT_VOICE, reference: "a.wav" };
    expect(voiceKey({ ...base, trackId: "x" })).toBe(voiceKey(base));
    expect(voiceKey({ ...base, reference: "b.wav" })).not.toBe(voiceKey(base));
    // Exaggeration does nothing on Turbo, so it does not make a Turbo line stale.
    expect(voiceKey({ ...base, exaggeration: 1.5 })).toBe(voiceKey(base));
    const standard = { ...base, engine: "standard" as const };
    expect(voiceKey({ ...standard, exaggeration: 1.5 })).not.toBe(voiceKey(standard));
  });

  it("speaks a cue's lines as one sentence", () => {
    expect(speechText({ text: "  Two\nlines  here " })).toBe("Two lines here");
  });
});

describe("generated lines", () => {
  const take = (file: string, duration = 1.5) => ({ file, seed: 1, duration });

  it("places a first take at the cue, on a new track when there is none", () => {
    const vo = placeTake(defaultVoiceover(), cue("c1", 4, 6, "Hello there"), take("a.wav"));
    expect(voiceTracks(vo)).toHaveLength(1);
    expect(vo.clips[0]).toMatchObject({ start: 4, file: "a.wav", duration: 1.5, name: "Hello there" });
    expect(vo.clips[0].source).toMatchObject({ cueId: "c1", text: "Hello there" });
  });

  it("puts a speaker's lines on their own track when it exists", () => {
    let vo = addTrack(addTrack(defaultVoiceover()));
    const second = voiceTracks(vo)[1].id;
    vo = setVoice(vo, "s1", { trackId: second });
    expect(trackForVoice(vo, "s1").trackId).toBe(second);
    expect(trackForVoice(vo, "s2").trackId).toBe(voiceTracks(vo)[0].id);
  });

  it("adds a new take to the existing clip, keeping where it was moved to", () => {
    const line = cue("c1", 4, 6, "Hello");
    let vo = placeTake(defaultVoiceover(), line, take("a.wav"));
    vo = moveClip(vo, vo.clips[0].id, 4.5);
    vo = placeTake(vo, line, take("b.wav", 2));
    expect(vo.clips).toHaveLength(1);
    expect(vo.clips[0]).toMatchObject({ start: 4.5, file: "b.wav", duration: 2 });
    expect(vo.clips[0].takes?.map((t) => t.file)).toEqual(["a.wav", "b.wav"]);

    const back = selectTake(vo, vo.clips[0].id, 0).clips[0];
    expect(back).toMatchObject({ file: "a.wav", duration: 1.5, offset: 0 });
  });

  it("fits cues to their lines, leaving their text and their neighbours alone", () => {
    const cues = [cue("a", 1, 2, "One"), cue("b", 3, 4, "Two"), cue("c", 8, 9, "Three")];
    let vo = placeTake(defaultVoiceover(), cues[0], take("a.wav", 1.5));
    vo = moveClip(vo, vo.clips[0].id, 0.8);
    // b's line is long enough to reach into c's room.
    vo = placeTake(vo, cues[1], take("b.wav", 6));

    const fitted = fitCuesToLines(cues, vo, 60, 0.1);
    expect(fitted[0]).toMatchObject({ start: 0.8, end: 2.3, text: "One" });
    // Stopped short of c, minus the gap.
    expect(fitted[1].start).toBe(3);
    expect(fitted[1].end).toBeCloseTo(7.9, 9);
    // c has no line and does not move.
    expect(fitted[2]).toEqual(cues[2]);

    const onlyA = fitCuesToLines(cues, vo, 60, 0.1, new Set(["a"]));
    expect(onlyA[1]).toEqual(cues[1]);
  });

  it("deletes a take, falling back to a neighbour, and the clip with its last take", () => {
    const line = cue("c1", 4, 6, "Hello");
    let vo = placeTake(defaultVoiceover(), line, take("a.wav", 1));
    vo = placeTake(vo, line, take("b.wav", 2));
    vo = placeTake(vo, line, take("c.wav", 3));
    const id = vo.clips[0].id;

    // An unused take goes without touching what plays.
    const withoutA = removeTake(vo, id, 0).clips[0];
    expect(withoutA.takes?.map((t) => t.file)).toEqual(["b.wav", "c.wav"]);
    expect(withoutA.file).toBe("c.wav");

    // The take in use (the last) hands over to the one before it.
    const withoutC = removeTake(vo, id, 2).clips[0];
    expect(withoutC).toMatchObject({ file: "b.wav", duration: 2 });

    // The take in use (the middle) hands over to the one after it.
    const middle = removeTake(selectTake(vo, id, 1), id, 1).clips[0];
    expect(middle).toMatchObject({ file: "c.wav", duration: 3 });

    let single = placeTake(defaultVoiceover(), line, take("only.wav"));
    single = removeTake(single, single.clips[0].id, 0);
    expect(single.clips).toEqual([]);
    expect(removeTake(vo, id, 9)).toBe(vo);
  });

  it("knows when a line is missing, current or stale", () => {
    const line = cue("c1", 4, 6, "Hello");
    const empty = defaultVoiceover();
    expect(lineState(empty, line)).toBe("missing");
    const vo = placeTake(empty, line, take("a.wav"));
    expect(lineState(vo, line)).toBe("current");
    expect(lineState(vo, { ...line, text: "Hello!" })).toBe("stale");
    expect(lineState(setVoice(vo, "s1", { reference: "new.wav" }), line)).toBe("stale");
    expect(isClipStale(vo, vo.clips[0], [])).toBe(true);
    expect(isClipStale(vo, vo.clips[0], [line])).toBe(false);
  });

  it("lists what needs generating, skipping empty cues", () => {
    const cues = [cue("a", 0, 1, "One"), cue("b", 2, 3, "  "), cue("c", 4, 5, "Three")];
    const vo = placeTake(defaultVoiceover(), cues[0], take("a.wav"));
    expect(pendingCues(vo, cues).map((c) => c.id)).toEqual(["c"]);
  });

  it("measures how far a line runs past its cue", () => {
    const line = cue("c1", 4, 5, "Hello");
    const vo = placeTake(defaultVoiceover(), line, take("a.wav", 1.8));
    expect(overrun(vo.clips[0], [line])).toBeCloseTo(0.8, 9);
    expect(overrun(vo.clips[0], [{ ...line, end: 6 }])).toBe(0);
  });
});

describe("references", () => {
  it("takes the speaker's longest spoken lines, in story order", () => {
    const cues: Cue[] = [
      cue("a", 0, 2, "short"),
      cue("b", 10, 18, "long"),
      cue("c", 20, 27, "longer still"),
      cue("d", 30, 40, "thinking", "s1"),
      cue("e", 50, 60, "someone else", "s2"),
    ];
    cues[3].mode = "thought";
    // 7 + 8 = 15 s is enough; the thought and the other speaker are left out.
    expect(referenceSegments(cues, "s1")).toEqual([
      [10, 18],
      [20, 27],
    ]);
    expect(referenceSegments([cue("x", 0, 3, "hi", null)], NO_SPEAKER)).toEqual([[0, 3]]);
  });

  it("caps the total length", () => {
    const segments = referenceSegments([cue("a", 0, 40, "a very long monologue")], "s1");
    expect(segments).toEqual([[0, 25]]);
  });

  it("writes takes beside the video", () => {
    expect(takePath("D:\\clips", "film", "abcdef123456", 42)).toBe(
      "D:\\clips\\film.voiceover\\abcdef12-42.wav",
    );
    expect(takePath("/home/a", "film", "abc", 1)).toBe("/home/a/film.voiceover/abc-1.wav");
  });
});

describe("voice scripts and direction", () => {
  const line = cue("c1", 4, 6, "I'm fine.");

  it("speaks the cue's own text until a script is written", () => {
    expect(renderLine(defaultVoiceover(), line).text).toBe("I'm fine.");
    const vo = setVoicing(defaultVoiceover(), "c1", line.text, { spoken: "[sigh] I'm fine." });
    expect(renderLine(vo, line).text).toBe("[sigh] I'm fine.");
  });

  it("drops a script identical to the cue, and an entry with nothing in it", () => {
    let vo = setVoicing(defaultVoiceover(), "c1", line.text, { spoken: "I'm fine." });
    expect(vo.voicing).toEqual({});
    vo = setVoicing(vo, "c1", line.text, { direction: "tired" });
    vo = setVoicing(vo, "c1", line.text, { direction: " " });
    expect(vo.voicing).toEqual({});
  });

  it("keeps a trailing space while the script is being typed", () => {
    const vo = setVoicing(defaultVoiceover(), "c1", line.text, { spoken: "I'm fine. " });
    expect(vo.voicing.c1?.spoken).toBe("I'm fine. ");
    // It still speaks, and counts as, the cue's own line.
    expect(renderLine(vo, line).text).toBe("I'm fine.");
  });

  it("turns direction into tags for Turbo, without doubling one already written", () => {
    let vo = setVoicing(defaultVoiceover(), "c1", line.text, {
      spoken: "[whispering] I'm fine.",
      direction: "whispered, laughing",
    });
    expect(renderLine(vo, line).text).toBe("[laugh] [whispering] I'm fine.");
    vo = setVoicing(vo, "c1", line.text, { spoken: undefined });
    expect(renderLine(vo, line).text).toBe("[whispering] [laugh] I'm fine.");
  });

  it("gives Expressive an intensity instead, and no tags to read aloud", () => {
    let vo = setVoice(defaultVoiceover(), "s1", { engine: "standard", exaggeration: 0.7 });
    vo = setVoicing(vo, "c1", line.text, { spoken: "[sigh] I'm fine.", direction: "screaming" });
    expect(renderLine(vo, line)).toMatchObject({ text: "I'm fine.", exaggeration: 1.6 });
    vo = setVoicing(vo, "c1", line.text, { direction: "slowly" });
    expect(renderLine(vo, line).exaggeration).toBe(0.7);
  });

  it("marks a spoken line stale when its script or direction changes", () => {
    const take = { file: "a.wav", seed: 1, duration: 1 };
    const vo = placeTake(defaultVoiceover(), line, take);
    expect(lineState(vo, line)).toBe("current");
    expect(lineState(setVoicing(vo, "c1", line.text, { direction: "angry" }), line)).toBe("stale");
    expect(lineState(setVoicing(vo, "c1", line.text, { direction: "slowly" }), line)).toBe("current");
    expect(lineState(setVoicing(vo, "c1", line.text, { spoken: "Fine." }), line)).toBe("stale");
  });

  it("counts a silent cue with a script as something to say", () => {
    const silent = cue("c2", 8, 9, "");
    const vo = setVoicing(defaultVoiceover(), "c2", "", { spoken: "[sigh]" });
    expect(pendingCues(vo, [silent]).map((c) => c.id)).toEqual(["c2"]);
    expect(pendingCues(defaultVoiceover(), [silent])).toEqual([]);
  });
});
