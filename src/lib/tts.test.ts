import { describe, expect, it } from "vitest";

import type { Cue, Voiceover } from "../types";
import {
  DEFAULT_VOICE,
  GROUP_MAX_CHARS,
  NO_SPEAKER,
  fitCuesToLines,
  lineGroups,
  lineIndex,
  overrun,
  placeTake,
  proportionalMarks,
  referenceSegments,
  removeTake,
  renderGroup,
  renderLine,
  selectTake,
  setJoin,
  setVoice,
  setVoicing,
  speechText,
  suggestedReferenceCues,
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

const take = (file: string, duration = 1.5) => ({ file, seed: 1, duration });

/** The state of the line `c` is in. */
const stateOf = (vo: Voiceover, cues: Cue[], c: Cue) => {
  const index = lineIndex(vo, cues);
  return index.stateOf(index.groupOf(c.id) ?? [c]);
};

const ids = (groups: Cue[][]) => groups.map((g) => g.map((c) => c.id));

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

describe("grouping", () => {
  it("joins a sentence the subtitles split, with no pause between", () => {
    const cues = [cue("a", 0, 2, "I told you the bridge"), cue("b", 2.2, 4, "is closed after dark.")];
    expect(ids(lineGroups(defaultVoiceover(), cues))).toEqual([["a", "b"]]);
  });

  it("keeps apart what ends a sentence, pauses, or changes speaker or mode", () => {
    const vo = defaultVoiceover();
    const ended = [cue("a", 0, 2, "Stop."), cue("b", 2.1, 4, "now")];
    expect(ids(lineGroups(vo, ended))).toEqual([["a"], ["b"]]);
    const quoted = [cue("a", 0, 2, 'He said "stop!"'), cue("b", 2.1, 4, "and left")];
    expect(ids(lineGroups(vo, quoted))).toEqual([["a"], ["b"]]);
    const paused = [cue("a", 0, 2, "I told you"), cue("b", 3, 4, "the bridge")];
    expect(ids(lineGroups(vo, paused))).toEqual([["a"], ["b"]]);
    const speakers = [cue("a", 0, 2, "I told you"), cue("b", 2.1, 4, "the bridge", "s2")];
    expect(ids(lineGroups(vo, speakers))).toEqual([["a"], ["b"]]);
    const thought: Cue[] = [cue("a", 0, 2, "I told you"), { ...cue("b", 2.1, 4, "the bridge"), mode: "thought" }];
    expect(ids(lineGroups(vo, thought))).toEqual([["a"], ["b"]]);
  });

  it("reads the voice script, tags aside, for where a sentence ends", () => {
    const cues = [cue("a", 0, 2, "Wait"), cue("b", 2.1, 4, "for me")];
    const ended = setVoicing(defaultVoiceover(), "a", "Wait", { spoken: "Wait. [sigh]" });
    expect(ids(lineGroups(ended, cues))).toEqual([["a"], ["b"]]);
  });

  it("caps a line's length", () => {
    const long = "word ".repeat(GROUP_MAX_CHARS / 10).trim();
    const cues = [cue("a", 0, 5, long), cue("b", 5.1, 10, long), cue("c", 10.1, 15, long)];
    expect(lineGroups(defaultVoiceover(), cues).every((g) => g.length < 3)).toBe(true);
    const span = [cue("a", 0, 12, "one"), cue("b", 12.1, 24, "two")];
    expect(ids(lineGroups(defaultVoiceover(), span))).toEqual([["a"], ["b"]]);
  });

  it("follows a split or join chosen by hand, but never across speakers", () => {
    const cues = [cue("a", 0, 2, "I told you"), cue("b", 2.1, 4, "the bridge"), cue("c", 5, 6, "Fine.")];
    let vo = setJoin(defaultVoiceover(), "a", "split");
    expect(ids(lineGroups(vo, cues))).toEqual([["a"], ["b"], ["c"]]);
    vo = setJoin(vo, "b", "join");
    expect(ids(lineGroups(vo, cues))).toEqual([["a"], ["b", "c"]]);
    vo = setJoin(vo, "a", undefined);
    expect(ids(lineGroups(vo, cues))).toEqual([["a", "b", "c"]]);
    const other = [cue("a", 0, 2, "Hi"), cue("b", 2.1, 4, "there", "s2")];
    expect(ids(lineGroups(setJoin(defaultVoiceover(), "a", "join"), other))).toEqual([["a"], ["b"]]);
  });

  it("speaks a group's parts in order, at its strongest intensity", () => {
    const cues = [cue("a", 0, 2, "I told you"), cue("b", 2.1, 4, "the bridge")];
    let vo = setVoicing(defaultVoiceover(), "b", "the bridge", { spoken: "[sigh] the bridge" });
    expect(renderGroup(vo, cues).text).toBe("I told you [sigh] the bridge");
    vo = setVoice(vo, "s1", { engine: "standard", exaggeration: 0.5 });
    vo = setVoicing(vo, "a", "I told you", { direction: "shouting" });
    expect(renderGroup(vo, cues)).toMatchObject({ text: "I told you the bridge", exaggeration: 1.2 });
  });
});

describe("generated lines", () => {
  it("places a first take at the cue, on a new track when there is none", () => {
    const vo = placeTake(defaultVoiceover(), [cue("c1", 4, 6, "Hello there")], take("a.wav"));
    expect(voiceTracks(vo)).toHaveLength(1);
    expect(vo.clips[0]).toMatchObject({ start: 4, file: "a.wav", duration: 1.5, name: "Hello there" });
    expect(vo.clips[0].source).toMatchObject({ cueIds: ["c1"], text: "Hello there" });
  });

  it("puts a speaker's lines on their own track when it exists", () => {
    let vo = addTrack(addTrack(defaultVoiceover()));
    const second = voiceTracks(vo)[1].id;
    vo = setVoice(vo, "s1", { trackId: second });
    expect(trackForVoice(vo, "s1").trackId).toBe(second);
    expect(trackForVoice(vo, "s2").trackId).toBe(voiceTracks(vo)[0].id);
  });

  it("adds a new take to the existing clip, keeping where it was moved to", () => {
    const line = [cue("c1", 4, 6, "Hello")];
    let vo = placeTake(defaultVoiceover(), line, take("a.wav"));
    vo = moveClip(vo, vo.clips[0].id, 4.5);
    vo = placeTake(vo, line, take("b.wav", 2));
    expect(vo.clips).toHaveLength(1);
    expect(vo.clips[0]).toMatchObject({ start: 4.5, file: "b.wav", duration: 2 });
    expect(vo.clips[0].takes?.map((t) => t.file)).toEqual(["a.wav", "b.wav"]);

    const back = selectTake(vo, vo.clips[0].id, 0).clips[0];
    expect(back).toMatchObject({ file: "a.wav", duration: 1.5, offset: 0 });
  });

  it("replaces the separate clips of cues that are now spoken as one line", () => {
    const cues = [cue("a", 0, 2, "I told you"), cue("b", 2.1, 4, "the bridge")];
    let vo = setJoin(defaultVoiceover(), "a", "split");
    vo = placeTake(vo, [cues[0]], take("a.wav"));
    vo = placeTake(vo, [cues[1]], take("b.wav"));
    vo = setJoin(vo, "a", undefined);
    // Regrouped: both old clips are out of date until the line is spoken.
    expect(vo.clips.every((c) => lineIndex(vo, cues).isStale(c))).toBe(true);
    vo = placeTake(vo, cues, take("ab.wav", 3));
    expect(vo.clips).toHaveLength(1);
    expect(vo.clips[0].source?.cueIds).toEqual(["a", "b"]);
    expect(stateOf(vo, cues, cues[1])).toBe("current");
  });

  it("knows when a line is missing, current or stale", () => {
    const line = cue("c1", 4, 6, "Hello");
    const empty = defaultVoiceover();
    expect(stateOf(empty, [line], line)).toBe("missing");
    const vo = placeTake(empty, [line], take("a.wav"));
    expect(stateOf(vo, [line], line)).toBe("current");
    const edited = { ...line, text: "Hello!" };
    expect(stateOf(vo, [edited], edited)).toBe("stale");
    expect(stateOf(setVoice(vo, "s1", { reference: "new.wav" }), [line], line)).toBe("stale");
    expect(lineIndex(vo, []).isStale(vo.clips[0])).toBe(true);
    expect(lineIndex(vo, [line]).isStale(vo.clips[0])).toBe(false);
  });

  it("lists what needs generating, skipping empty cues", () => {
    const cues = [cue("a", 0, 1, "One."), cue("b", 2, 3, "  "), cue("c", 4, 5, "Three.")];
    const vo = placeTake(defaultVoiceover(), [cues[0]], take("a.wav"));
    expect(ids(lineIndex(vo, cues).pending)).toEqual([["c"]]);
  });

  it("measures how far a line runs past its last cue", () => {
    const cues = [cue("a", 4, 5, "Hello"), cue("b", 5.1, 6, "there")];
    const vo = placeTake(defaultVoiceover(), cues, take("a.wav", 2.8));
    expect(overrun(vo.clips[0], cues)).toBeCloseTo(0.8, 9);
    expect(overrun(vo.clips[0], [cues[0], { ...cues[1], end: 7 }])).toBe(0);
  });

  it("deletes a take, falling back to a neighbour, and the clip with its last take", () => {
    const line = [cue("c1", 4, 6, "Hello")];
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
});

describe("fitting cues to lines", () => {
  it("fits single cues to their clips, leaving text and neighbours alone", () => {
    const cues = [cue("a", 1, 2, "One."), cue("b", 3, 4, "Two."), cue("c", 8, 9, "Three.")];
    let vo = placeTake(defaultVoiceover(), [cues[0]], take("a.wav", 1.5));
    vo = moveClip(vo, vo.clips[0].id, 0.8);
    // b's line is long enough to reach into c's room.
    vo = placeTake(vo, [cues[1]], take("b.wav", 6));

    const fitted = fitCuesToLines(cues, vo, 60, 0.1);
    expect(fitted[0]).toMatchObject({ start: 0.8, end: 2.3, text: "One." });
    // Stopped short of c, minus the gap.
    expect(fitted[1].start).toBe(3);
    expect(fitted[1].end).toBeCloseTo(7.9, 9);
    // c has no line and does not move.
    expect(fitted[2]).toEqual(cues[2]);

    const onlyA = fitCuesToLines(cues, vo, 60, 0.1, new Set(["a"]));
    expect(onlyA[1]).toEqual(cues[1]);
  });

  it("fits each cue of a joined line to its own words, as aligned", () => {
    const cues = [cue("a", 10, 12, "I told you"), cue("b", 12.1, 14, "the bridge")];
    let vo = placeTake(defaultVoiceover(), cues, {
      file: "ab.wav",
      seed: 1,
      duration: 4,
      marks: [
        [0.2, 1.5],
        [1.9, 3.6],
      ],
    });
    vo = moveClip(vo, vo.clips[0].id, 20);
    const fitted = fitCuesToLines(cues, vo, 60, 0.1);
    expect(fitted[0]).toMatchObject({ start: 20.2, end: 21.5 });
    expect(fitted[1]).toMatchObject({ start: 21.9, end: 23.6 });
  });

  it("estimates by length when a joined take has no alignment", () => {
    expect(proportionalMarks(["ab", "abcdef"], 4)).toEqual([
      [0, 1],
      [1, 4],
    ]);
    const cues = [cue("a", 0, 2, "ab"), cue("b", 2.1, 4, "abcdef")];
    const vo = placeTake(defaultVoiceover(), cues, take("ab.wav", 4));
    const fitted = fitCuesToLines(cues, vo, 60, 0.1);
    expect(fitted[0]).toMatchObject({ start: 0, end: 1 });
    expect(fitted[1]).toMatchObject({ start: 1.1, end: 4 });
  });
});

describe("references", () => {
  it("suggests the speaker's longest spoken lines, in story order", () => {
    const cues: Cue[] = [
      cue("a", 0, 2, "short"),
      cue("b", 10, 18, "long"),
      cue("c", 20, 27, "longer still"),
      cue("d", 30, 40, "thinking", "s1"),
      cue("e", 50, 60, "someone else", "s2"),
    ];
    cues[3].mode = "thought";
    // 7 + 8 = 15 s is enough; the thought and the other speaker are left out.
    expect(suggestedReferenceCues(cues, "s1").map((c) => c.id)).toEqual(["b", "c"]);
    expect(suggestedReferenceCues([cue("x", 0, 3, "hi", null)], NO_SPEAKER).map((c) => c.id)).toEqual(["x"]);
  });

  it("cuts the chosen cues in time order, capped in total length", () => {
    expect(referenceSegments([cue("b", 10, 12, "b"), cue("a", 0, 3, "a")])).toEqual([
      [0, 3],
      [10, 12],
    ]);
    expect(referenceSegments([cue("a", 0, 40, "a very long monologue")])).toEqual([[0, 25]]);
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
    const vo = placeTake(defaultVoiceover(), [line], take("a.wav", 1));
    expect(stateOf(vo, [line], line)).toBe("current");
    expect(stateOf(setVoicing(vo, "c1", line.text, { direction: "angry" }), [line], line)).toBe("stale");
    expect(stateOf(setVoicing(vo, "c1", line.text, { direction: "slowly" }), [line], line)).toBe("current");
    expect(stateOf(setVoicing(vo, "c1", line.text, { spoken: "Fine." }), [line], line)).toBe("stale");
  });

  it("counts a silent cue with a script as something to say", () => {
    const silent = cue("c2", 8, 9, "");
    const vo = setVoicing(defaultVoiceover(), "c2", "", { spoken: "[sigh]" });
    expect(ids(lineIndex(vo, [silent]).pending)).toEqual([["c2"]]);
    expect(lineIndex(defaultVoiceover(), [silent]).pending).toEqual([]);
  });
});
