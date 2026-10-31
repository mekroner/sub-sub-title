import { describe, expect, it } from "vitest";

import type { Cue, Voiceover } from "../types";
import {
  DEFAULT_VOICE,
  GROUP_MAX_CHARS,
  NO_SPEAKER,
  fitCuesToLines,
  lineGroups,
  SUSPECT_RATE,
  SUSPECT_SCORE,
  addTake,
  fitRatio,
  stretchPath,
  stretchedTake,
  isSuspect,
  lineIndex,
  nextLine,
  overrun,
  placeTake,
  placeTakes,
  rankTakes,
  playTake,
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

  it("plays a take's speech, so the first word lands where the clip starts", () => {
    const line = [cue("c1", 4, 6, "Hello")];
    const spoken = { ...take("a.wav", 2), speech: [0.3, 1.6] as [number, number] };
    let vo = placeTake(defaultVoiceover(), line, spoken);
    expect(vo.clips[0]).toMatchObject({ start: 4, offset: 0.3, sourceDuration: 2 });
    expect(vo.clips[0].duration).toBeCloseTo(1.3, 9);

    // A take without a window plays whole; switching back trims again.
    vo = placeTake(vo, line, take("b.wav", 2.5));
    expect(vo.clips[0]).toMatchObject({ file: "b.wav", offset: 0, duration: 2.5 });
    vo = selectTake(vo, vo.clips[0].id, 0);
    expect(vo.clips[0]).toMatchObject({ file: "a.wav", offset: 0.3 });
    vo = removeTake(vo, vo.clips[0].id, 0);
    expect(vo.clips[0]).toMatchObject({ file: "b.wav", offset: 0, duration: 2.5 });

    // A window that does not fit the file is held inside it.
    expect(playTake({ ...take("c.wav", 1), speech: [0.2, 4] })).toMatchObject({ offset: 0.2, duration: 0.8 });
  });

  it("flags a checked take whose words were hard to find, or that rushed or stalled", () => {
    const checked = (score: number, rate: number) => ({ ...take("a.wav"), check: { score, rate } });
    expect(isSuspect(take("a.wav"))).toBe(false);
    expect(isSuspect(checked(0.8, 14))).toBe(false);
    expect(isSuspect(checked(SUSPECT_SCORE - 0.01, 14))).toBe(true);
    expect(isSuspect(checked(0.8, SUSPECT_RATE[1] + 1))).toBe(true);
    expect(isSuspect(checked(0.8, SUSPECT_RATE[0] - 1))).toBe(true);
  });

  it("keeps the take that says its line and best fits its cues", () => {
    const t = (file: string, speech: number, score?: number) => ({
      ...take(file, speech + 0.4),
      speech: [0.2, 0.2 + speech] as [number, number],
      ...(score === undefined ? {} : { check: { score, rate: 12 } }),
    });
    // Running long is worse than running as short.
    expect(rankTakes([t("long", 2.4), t("short", 1.6)], 2)).toBe(1);
    expect(rankTakes([t("long", 2.1), t("short", 1.6)], 2)).toBe(0);
    // A take that may not say its line loses, however well it fits.
    expect(rankTakes([t("garbled", 2, 0.2), t("clean", 1.5, 0.9)], 2)).toBe(1);
    // As good a fit: the surer take.
    expect(rankTakes([t("a", 2, 0.85), t("b", 2.02, 0.97)], 2)).toBe(1);
    expect(rankTakes([t("only", 3)], 2)).toBe(0);

    const line = [cue("c1", 4, 6, "Hello")];
    const vo = placeTakes(defaultVoiceover(), line, [t("x", 2.6), t("y", 1.9)], 1);
    expect(vo.clips).toHaveLength(1);
    expect(vo.clips[0].file).toBe("y");
    expect(vo.clips[0].takes?.map((k) => k.file)).toEqual(["x", "y"]);
    const again = placeTakes(vo, line, [t("z", 2)], 0);
    expect(again.clips[0].takes?.map((k) => k.file)).toEqual(["x", "y", "z"]);
    expect(again.clips[0].file).toBe("z");
  });

  it("speeds up an overrunning line to end with its cue, as a new take", () => {
    const line = [cue("c1", 4, 6, "Hello there")];
    const spoken = {
      ...take("D:/vo/a.wav", 2.4),
      speech: [0.1, 2.3] as [number, number],
      marks: [[0.1, 2.3]] as Array<[number, number]>,
    };
    let vo = placeTake(defaultVoiceover(), line, spoken);
    // 2.2 s of speech in 2 s of cue.
    expect(fitRatio(vo.clips[0], line)).toBeCloseTo(1.1, 3);
    expect(fitRatio(vo.clips[0], [{ ...line[0], end: 6.5 }])).toBeNull();
    expect(fitRatio(vo.clips[0], [{ ...line[0], end: 5.5 }])).toBeNull(); // past MAX_STRETCH

    const ratio = fitRatio(vo.clips[0], line)!;
    const file = stretchPath(spoken.file, ratio);
    expect(file).toBe("D:/vo/a-x1.100.wav");
    const fast = stretchedTake(spoken, ratio, file, 2.4 / ratio);
    expect(fast).toMatchObject({ stretch: ratio, original: "D:/vo/a.wav", seed: 1 });
    expect(fast.speech![1]).toBeCloseTo(2.3 / ratio, 9);
    vo = addTake(vo, vo.clips[0].id, fast);
    expect(vo.clips[0]).toMatchObject({ file, start: 4 });
    expect(overrun(vo.clips[0], line)).toBe(0);
    expect(vo.clips[0].takes?.map((t) => t.file)).toEqual([spoken.file, file]);

    // Stretching again starts from the take as spoken, and replaces a repeat.
    const again = stretchedTake(fast, 1.15, stretchPath(fast.original!, 1.15), 2.4 / 1.15);
    expect(again.original).toBe("D:/vo/a.wav");
    expect(again.speech![1]).toBeCloseTo(2.3 / 1.15, 9);
    expect(addTake(vo, vo.clips[0].id, fast).clips[0].takes).toHaveLength(2);
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

  it("speaks each model's lines together, earliest first", () => {
    let vo = setVoice(defaultVoiceover(), "s2", { engine: "standard" });
    vo = setVoice(vo, "s3", { reference: "r.wav" });
    const queue = [
      [cue("a", 0, 1, "One.", "s1")],
      [cue("b", 2, 3, "Two.", "s2")],
      [cue("c", 4, 5, "Three.", "s3")],
      [cue("d", 6, 7, "Four.", "s1")],
      [cue("e", 8, 9, "Five.", "s2")],
    ];
    expect(nextLine(vo, queue, null)).toBe(0);
    // Turbo with no reference was last: its own line before another reference.
    expect(nextLine(vo, queue.slice(1), voiceFor(vo, "s1"))).toBe(2);
    expect(nextLine(vo, [queue[1], queue[2], queue[4]], voiceFor(vo, "s1"))).toBe(1);
    expect(nextLine(vo, [queue[2], queue[4]], voiceFor(vo, "s2"))).toBe(1);
    expect(nextLine(vo, [], null)).toBe(-1);
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

  it("estimates within a take's speech, not its silence", () => {
    expect(proportionalMarks(["ab", "abcdef"], 4, 0.5)).toEqual([
      [0.5, 1.5],
      [1.5, 4.5],
    ]);
    const cues = [cue("a", 10, 12, "ab"), cue("b", 12.1, 15, "abcdef")];
    const spoken = { ...take("ab.wav", 5), speech: [0.5, 4.5] as [number, number] };
    const vo = placeTake(defaultVoiceover(), cues, spoken);
    // The clip starts at 10 with the speech, so the words run 10..11 and 11..14.
    const fitted = fitCuesToLines(cues, vo, 60, 0.1);
    expect(fitted[0]).toMatchObject({ start: 10, end: 11 });
    expect(fitted[1]).toMatchObject({ start: 11.1, end: 14 });
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
