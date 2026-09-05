import { describe, expect, it } from "vitest";
import {
  detectSpeakerPrefixes,
  mergeImportedSpeakers,
  parseSrt,
  serializeSrt,
  stripSpeakerPrefix,
} from "./srt";
import { formatSrtTime, parseTimecode } from "./time";
import type { Cue, Speaker } from "../types";
import { DEFAULT_MIN_GAP, findOverlaps } from "./cues";

const SAMPLE = `1
00:00:01,000 --> 00:00:03,500
Hello there.

2
00:00:04,000 --> 00:00:06,250
General Kenobi.
You are a bold one.

3
00:00:07,000 --> 00:00:09,000
<i>Music playing</i>
`;

describe("parseSrt", () => {
  it("reads index, timecodes and multi-line text", () => {
    const { cues } = parseSrt(SAMPLE);
    expect(cues).toHaveLength(3);
    expect(cues[0].start).toBeCloseTo(1.0, 5);
    expect(cues[0].end).toBeCloseTo(3.5, 5);
    expect(cues[1].text).toBe("General Kenobi.\nYou are a bold one.");
    expect(cues[2].text).toBe("<i>Music playing</i>");
  });

  it("survives CRLF line endings", () => {
    const { cues } = parseSrt(SAMPLE.replace(/\n/g, "\r\n"));
    expect(cues).toHaveLength(3);
    expect(cues[1].text).toBe("General Kenobi.\nYou are a bold one.");
  });

  it("handles blocks with no blank line between them", () => {
    const squashed = `1
00:00:01,000 --> 00:00:02,000
First
2
00:00:03,000 --> 00:00:04,000
Second`;
    const { cues } = parseSrt(squashed);
    expect(cues.map((c) => c.text)).toEqual(["First", "Second"]);
  });

  it("repairs a cue that ends before it starts", () => {
    const broken = `1
00:00:05,000 --> 00:00:02,000
Backwards`;
    const { cues, warnings } = parseSrt(broken);
    expect(cues[0].end).toBeGreaterThan(cues[0].start);
    expect(warnings).toHaveLength(1);
  });

  it("skips empty cues rather than emitting blank captions", () => {
    const withEmpty = `1
00:00:01,000 --> 00:00:02,000

2
00:00:03,000 --> 00:00:04,000
Real text`;
    const { cues } = parseSrt(withEmpty);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("Real text");
  });

  it("returns cues sorted by start time", () => {
    const outOfOrder = `1
00:00:09,000 --> 00:00:10,000
Later
2
00:00:01,000 --> 00:00:02,000
Earlier`;
    const { cues } = parseSrt(outOfOrder);
    expect(cues.map((c) => c.text)).toEqual(["Earlier", "Later"]);
  });
});

describe("round trip", () => {
  it("re-serialises to the same text it parsed", () => {
    const { cues } = parseSrt(SAMPLE);
    const out = serializeSrt(cues);
    const { cues: reparsed } = parseSrt(out);

    expect(reparsed).toHaveLength(cues.length);
    for (let i = 0; i < cues.length; i += 1) {
      expect(reparsed[i].text).toBe(cues[i].text);
      expect(reparsed[i].start).toBeCloseTo(cues[i].start, 3);
      expect(reparsed[i].end).toBeCloseTo(cues[i].end, 3);
    }
  });

  it("renumbers indices sequentially from 1", () => {
    const { cues } = parseSrt(SAMPLE);
    const out = serializeSrt(cues);
    expect(out.split("\n")[0]).toBe("1");
    expect(out).toContain("\n3\n");
  });
});

describe("timecodes", () => {
  it("formats and parses symmetrically", () => {
    expect(formatSrtTime(3661.234)).toBe("01:01:01,234");
    expect(parseTimecode("01:01:01,234")).toBeCloseTo(3661.234, 3);
    expect(parseTimecode("1:23.5")).toBeCloseTo(83.5, 3);
    expect(parseTimecode("12.75")).toBeCloseTo(12.75, 3);
    expect(parseTimecode("nonsense")).toBeNull();
  });
});

/** One cue per line of `texts`, a second apart, so a case reads as its input. */
function cuesFrom(...texts: string[]): string {
  return texts
    .map(
      (text, i) =>
        `${i + 1}\n00:00:0${i + 1},000 --> 00:00:0${i + 1},500\n${text}\n`,
    )
    .join("\n");
}

describe("font colour import", () => {
  it("groups cues by colour, in order of first appearance", () => {
    const { cues, speakers } = parseSrt(
      cuesFrom(
        '<font color="#ff0000">Red one</font>',
        '<font color="#0000ff">Blue</font>',
        '<font color="#ff0000">Red two</font>',
      ),
    );
    expect(speakers.map((s) => s.color)).toEqual(["#ff0000", "#0000ff"]);
    expect(speakers.map((s) => s.count)).toEqual([2, 1]);
    expect(cues.map((c) => c.speakerId)).toEqual([
      speakers[0].id,
      speakers[1].id,
      speakers[0].id,
    ]);
    expect(cues.map((c) => c.text)).toEqual(["Red one", "Blue", "Red two"]);
  });

  it("accepts the attribute forms real files use", () => {
    const { speakers } = parseSrt(
      cuesFrom(
        "<font color=#ff0000>Unquoted</font>",
        "<font color='#00FF00'>Single quoted</font>",
        '<font color="#FFF">Three digit</font>',
        '<font color="yellow">Named</font>',
      ),
    );
    expect(speakers.map((s) => s.color)).toEqual([
      "#ff0000",
      "#00ff00",
      "#ffffff",
      "#ffff00",
    ]);
  });

  it("reads the colour past other attributes, whitespace and case", () => {
    const { speakers } = parseSrt(
      cuesFrom('<FONT Face="Arial" COLOR = "#ABCDEF" size="2">Hello</FONT>'),
    );
    expect(speakers.map((s) => s.color)).toEqual(["#abcdef"]);
  });

  it("skips a font tag carrying no colour rather than giving up", () => {
    const { cues, speakers } = parseSrt(
      cuesFrom('<font face="Arial">plain <font color="#ff0000">red</font></font>'),
    );
    expect(speakers.map((s) => s.color)).toEqual(["#ff0000"]);
    expect(cues[0].text).toBe("plain red");
  });

  it("splits a two-speaker block into a cue each, dividing the time", () => {
    const { cues, speakers, split } = parseSrt(`1
00:00:05,784 --> 00:00:07,750
<font color="cornflowerBlue">Hey dude.
<font color="pink"> Hey.
`);
    expect(split).toBe(1);
    expect(speakers.map((s) => s.color)).toEqual(["#6495ed", "#ffc0cb"]);
    expect(cues.map((c) => c.text)).toEqual(["Hey dude.", "Hey."]);
    expect(cues.map((c) => c.speakerId)).toEqual([speakers[0].id, speakers[1].id]);

    // Split evenly across the block, minus the enforced gap between them, and
    // landing exactly on the block's own end.
    expect(cues[0].start).toBeCloseTo(5.784, 3);
    expect(cues[0].end).toBeCloseTo(6.747, 3);
    expect(cues[1].start).toBeCloseTo(6.787, 3);
    expect(cues[1].end).toBeCloseTo(7.75, 3);

    // The import must not hand back cues its own overlap check rejects.
    expect(findOverlaps(cues, DEFAULT_MIN_GAP)).toEqual([]);
  });

  it("honours a custom minimum gap when splitting", () => {
    const { cues } = parseSrt(
      `1\n00:00:00,000 --> 00:00:02,000\n<font color="#ff0000">A\n<font color="#0000ff">B\n`,
      { minGap: 0.5 },
    );
    expect(cues[0].end).toBeCloseTo(0.75, 3);
    expect(cues[1].start).toBeCloseTo(1.25, 3);
    expect(findOverlaps(cues, 0.5)).toEqual([]);
  });

  it("keeps a block whole when it is too short to divide", () => {
    // Splitting would mint cues under MIN_CUE_DURATION, which the editor forbids.
    const { cues, speakers, split } = parseSrt(`1
00:00:01,000 --> 00:00:01,100
<font color="#ff0000">A
<font color="#0000ff">B
`);
    expect(split).toBe(0);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("A\nB");
    expect(cues[0].speakerId).toBe(speakers[0].id);
  });

  it("treats a colour re-opened on every line as one speaker", () => {
    const { cues, split } = parseSrt(
      cuesFrom('<font color="#ff0000">One\n<font color="#ff0000">Two'),
    );
    expect(split).toBe(0);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("One\nTwo");
  });

  it("does not fragment prose that is only partly wrapped", () => {
    const { cues, split } = parseSrt(
      cuesFrom('Hello <font color="#ff0000">world</font>'),
    );
    expect(split).toBe(0);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("Hello world");
  });

  it("resolves CSS colour names beyond the HTML-4 set", () => {
    const { speakers } = parseSrt(
      cuesFrom(
        '<font color="cornflowerblue">a</font>',
        '<font color="pink">b</font>',
        '<font color="rebeccapurple">c</font>',
      ),
    );
    expect(speakers.map((s) => s.color)).toEqual(["#6495ed", "#ffc0cb", "#663399"]);
  });

  it("re-trims lines left indented by a removed tag", () => {
    const { cues } = parseSrt(
      cuesFrom('<font color="#ff0000">Hey dude.\n<font color="#ff0000"> Hey.'),
    );
    expect(cues[0].text).toBe("Hey dude.\nHey.");
  });

  it("leaves the spacing of an unmarked cue alone", () => {
    const { cues } = parseSrt(cuesFrom("Hey dude.\n  Hey."));
    expect(cues[0].text).toBe("Hey dude.\n  Hey.");
  });

  it("tags the whole cue when only part of it is wrapped", () => {
    const { cues, speakers } = parseSrt(
      cuesFrom('Hello <font color="#ff0000">world</font>'),
    );
    expect(cues[0].text).toBe("Hello world");
    expect(cues[0].speakerId).toBe(speakers[0].id);
  });

  it("survives unclosed openers and orphan closers", () => {
    const { cues, speakers } = parseSrt(
      cuesFrom('<font color="#ff0000">no close', "orphan</font>"),
    );
    expect(cues.map((c) => c.text)).toEqual(["no close", "orphan"]);
    expect(speakers.map((s) => s.color)).toEqual(["#ff0000"]);
    expect(cues[1].speakerId).toBeNull();
  });

  it("ignores an unreadable colour without warning about it", () => {
    // An `rgb()` function or a made-up name: no `#rrggbb` to hand a Speaker, and
    // an ignored colour is not a repaired line, so it must not raise a warning.
    const { cues, speakers, warnings } = parseSrt(
      cuesFrom('<font color="blurple">Hi</font>', "<font color=rgb(1,2,3)>There</font>"),
    );
    expect(speakers).toEqual([]);
    expect(cues.map((c) => c.speakerId)).toEqual([null, null]);
    expect(cues.map((c) => c.text)).toEqual(["Hi", "There"]);
    expect(warnings).toEqual([]);
  });

  it("leaves italics alone while stripping the font tags", () => {
    const { cues } = parseSrt(cuesFrom('<font color="#f00"><i>Music</i></font>'));
    expect(cues[0].text).toBe("<i>Music</i>");
  });

  it("skips a cue that is nothing but font tags", () => {
    const { cues, warnings } = parseSrt(
      cuesFrom('<font color="#ff0000"></font>', "Real text"),
    );
    expect(cues.map((c) => c.text)).toEqual(["Real text"]);
    expect(warnings).toHaveLength(1);
  });

  it("reports no speakers for a file with no font tags", () => {
    // Whisper output looks like this, so the import path must stay a no-op.
    const { cues, speakers } = parseSrt(SAMPLE);
    expect(speakers).toEqual([]);
    expect(cues.every((c) => c.speakerId === null)).toBe(true);
  });
});

describe("font colour export", () => {
  const speakers: Speaker[] = [
    { id: "s1", name: "Speaker 1", color: "#ff0000" },
    { id: "s2", name: "Speaker 2", color: "#0000ff" },
  ];
  const cue = (id: string, start: number, text: string, speakerId: string | null): Cue => ({
    id,
    start,
    end: start + 1,
    text,
    speakerId,
  });

  it("wraps each tagged cue in its speaker's colour", () => {
    const out = serializeSrt([cue("a", 1, "Hello", "s1")], {
      speakers,
      speakerColors: true,
    });
    expect(out).toContain('<font color="#ff0000">Hello</font>');
  });

  it("wraps a multi-line cue once, around the line break", () => {
    const out = serializeSrt([cue("a", 1, "First\nSecond", "s2")], {
      speakers,
      speakerColors: true,
    });
    expect(out).toContain('<font color="#0000ff">First\nSecond</font>');
    expect(out.match(/<font/g)).toHaveLength(1);
  });

  it("leaves a cue with no speaker bare", () => {
    const out = serializeSrt([cue("a", 1, "Narrator", null)], {
      speakers,
      speakerColors: true,
    });
    expect(out).not.toContain("<font");
    expect(out).toContain("Narrator");
  });

  it("writes a plain .srt when the toggle is off", () => {
    const cues = [cue("a", 1, "Hello", "s1")];
    expect(serializeSrt(cues, { speakers, speakerColors: false })).toBe(
      serializeSrt(cues),
    );
  });

  it("does not nest its tag inside one the user typed", () => {
    const out = serializeSrt(
      [cue("a", 1, '<font color="#00ff00">hi</font>', "s1")],
      { speakers, speakerColors: true },
    );
    expect(out.match(/<font/g)).toHaveLength(1);
    expect(out).toContain('<font color="#ff0000">hi</font>');
  });

  it("round-trips colours back into the same speaker grouping", () => {
    const original = [
      cue("a", 1, "Red one", "s1"),
      cue("b", 2, "Blue", "s2"),
      cue("c", 3, "Red two", "s1"),
      cue("d", 4, "Untagged", null),
    ];
    const out = serializeSrt(original, { speakers, speakerColors: true });
    const parsed = parseSrt(out);

    expect(parsed.speakers.map((s) => s.color)).toEqual(["#ff0000", "#0000ff"]);
    expect(parsed.cues.map((c) => c.text)).toEqual(original.map((c) => c.text));
    expect(parsed.cues[0].speakerId).toBe(parsed.cues[2].speakerId);
    expect(parsed.cues[1].speakerId).not.toBe(parsed.cues[0].speakerId);
    expect(parsed.cues[3].speakerId).toBeNull();
  });
});

describe("mergeImportedSpeakers", () => {
  const parse = (...texts: string[]) => parseSrt(cuesFrom(...texts));

  it("creates a speaker per unique colour when the project has none", () => {
    const { cues, speakers } = mergeImportedSpeakers(
      [],
      parse(
        '<font color="#ff0000">One</font>',
        '<font color="#0000ff">Two</font>',
        '<font color="#ff0000">One again</font>',
        "Untagged",
      ),
    );
    expect(speakers).toEqual([
      { id: expect.any(String), name: "Speaker 1", color: "#ff0000" },
      { id: expect.any(String), name: "Speaker 2", color: "#0000ff" },
    ]);
    expect(cues.map((c) => c.speakerId)).toEqual([
      speakers[0].id,
      speakers[1].id,
      speakers[0].id,
      null,
    ]);
  });

  it("numbers new speakers after the ones already in the project", () => {
    const existing: Speaker[] = [
      { id: "a", name: "Alex", color: "#111111" },
      { id: "b", name: "Sam", color: "#222222" },
    ];
    const { speakers } = mergeImportedSpeakers(
      existing,
      parse('<font color="#ff0000">One</font>', '<font color="#0000ff">Two</font>'),
    );
    expect(speakers.map((s) => s.name)).toEqual([
      "Alex",
      "Sam",
      "Speaker 3",
      "Speaker 4",
    ]);
  });

  it("reuses a speaker already using that colour, whatever its case", () => {
    const existing: Speaker[] = [
      { id: "a", name: "Alex", color: "#FF0000", voiceNotes: "dry" },
    ];
    const { cues, speakers } = mergeImportedSpeakers(
      existing,
      parse('<font color="#ff0000">Hello</font>'),
    );
    expect(speakers).toHaveLength(1);
    expect(speakers[0]).toEqual(existing[0]);
    expect(cues[0].speakerId).toBe("a");
  });

  it("leaves the project untouched when the file declares no colours", () => {
    const existing: Speaker[] = [{ id: "a", name: "Alex", color: "#111111" }];
    const parsed = parse("Plain text");
    const { cues, speakers } = mergeImportedSpeakers(existing, parsed);
    expect(speakers).toBe(existing);
    expect(cues).toBe(parsed.cues);
  });

  it("steps past a name that is already taken", () => {
    const existing: Speaker[] = [{ id: "a", name: "Speaker 2", color: "#111111" }];
    const { speakers } = mergeImportedSpeakers(
      existing,
      parse('<font color="#ff0000">One</font>'),
    );
    expect(speakers.map((s) => s.name)).toEqual(["Speaker 2", "Speaker 3"]);
  });
});

describe("speaker prefix detection", () => {
  it("finds names used at least twice", () => {
    const { cues } = parseSrt(`1
00:00:01,000 --> 00:00:02,000
ALEX: Hello

2
00:00:03,000 --> 00:00:04,000
SAM: Hi there

3
00:00:05,000 --> 00:00:06,000
ALEX: How are you`);
    const detected = detectSpeakerPrefixes(cues);
    expect(detected.map((d) => d.name)).toContain("ALEX");
    // SAM appears once, below the threshold.
    expect(detected.map((d) => d.name)).not.toContain("SAM");
  });

  it("strips the prefix from the text", () => {
    expect(stripSpeakerPrefix("ALEX: Hello there")).toBe("Hello there");
    expect(stripSpeakerPrefix("[Alex] Hello there")).toBe("Hello there");
    expect(stripSpeakerPrefix("No prefix here")).toBe("No prefix here");
  });

  it("does not treat ordinary prose with a colon as a speaker", () => {
    const text = "I told him one thing: never look back";
    expect(stripSpeakerPrefix(text)).toBe(text);
  });
});
