import { describe, expect, it } from "vitest";
import { detectSpeakerPrefixes, parseSrt, serializeSrt, stripSpeakerPrefix } from "./srt";
import { formatSrtTime, parseTimecode } from "./time";

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
