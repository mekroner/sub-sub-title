import { describe, expect, it } from "vitest";
import { numberWords, ordinalWords, speakable, yearWords } from "./speakable";

describe("numberWords", () => {
  it.each([
    [0, "zero"],
    [7, "seven"],
    [13, "thirteen"],
    [40, "forty"],
    [42, "forty-two"],
    [100, "one hundred"],
    [305, "three hundred five"],
    [1000, "one thousand"],
    [1234, "one thousand two hundred thirty-four"],
    [2_000_017, "two million seventeen"],
    [-3, "minus three"],
  ])("%d → %s", (n, words) => expect(numberWords(n)).toBe(words));
});

describe("ordinals and years", () => {
  it.each([
    [1, "first"],
    [2, "second"],
    [3, "third"],
    [11, "eleventh"],
    [12, "twelfth"],
    [20, "twentieth"],
    [22, "twenty-second"],
    [101, "one hundred first"],
  ])("ordinal %d → %s", (n, words) => expect(ordinalWords(n)).toBe(words));

  it.each([
    [1984, "nineteen eighty-four"],
    [1900, "nineteen hundred"],
    [1905, "nineteen oh five"],
    [2005, "two thousand five"],
    [2019, "twenty nineteen"],
  ])("year %d → %s", (n, words) => expect(yearWords(n)).toBe(words));
});

describe("speakable", () => {
  it.each([
    ["It cost $3.50 on May 12th, 1984.", "It cost three dollars and fifty cents on May twelfth, nineteen eighty-four."],
    ["$1 and $0.05", "one dollar and five cents"],
    ["£20 a head", "twenty pounds a head"],
    ["$5 million", "five million dollars"],
    ["€1.2m", "one point two million euros"],
    ["About 50% of them", "About fifty percent of them"],
    ["Meet me at 3:45.", "Meet me at three forty-five."],
    ["Back by 10:05pm!", "Back by ten oh five P M!"],
    ["At 7 a.m. sharp", "At seven A M sharp"],
    ["It's 3:00", "It's three o'clock"],
    ["Pages 5-10", "Pages five to ten"],
    ["It was -5 outside", "It was minus five outside"],
    ["Back in the '90s, in the 1980s", "Back in the nineties, in the nineteen eighties"],
    ["1,000,000 reasons", "one million reasons"],
    ["Pi is 3.14", "Pi is three point one four"],
    ["Call Mr. Smith and Dr. Jones & co.", "Call Mister Smith and Doctor Jones and co."],
    ["Room No. 9", "Room number nine"],
    ["COVID-19", "COVID-nineteen"],
    ["NO WAY", "NO WAY"],
    ["Nothing to change.", "Nothing to change."],
  ])("%s", (text, spoken) => expect(speakable(text)).toBe(spoken));

  it("leaves tags alone", () => {
    expect(speakable("[laugh] 2 of them [sigh]")).toBe("[laugh] two of them [sigh]");
  });

  it("says names as the project spells them, whole words only", () => {
    const pronunciations = { Siobhan: "shi-VAWN", "GIF": "jif" };
    expect(speakable("siobhan sent a GIF to Siobhan's GIFfy friend", pronunciations)).toBe(
      "shi-VAWN sent a jif to shi-VAWN's GIFfy friend",
    );
  });
});
