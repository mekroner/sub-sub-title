/**
 * Text as a voice should read it. Voice models guess at digits, symbols and
 * abbreviations — "1984" as "one nine eight four", "$3.50" as "dollar three
 * fifty" — and the word check cannot catch it, since it skips anything that
 * is not letters. So before a line is spoken, numbers and symbols are spelled
 * out in English words, and the project's own pronunciations are applied.
 *
 * Square-bracketed tags like [laugh] pass through untouched. ALL-CAPS words
 * are left alone: they are as often shouting as acronyms, and an acronym that
 * should be spelled out belongs in the pronunciations.
 */

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: Array<[number, string]> = [
  [1e12, "trillion"],
  [1e9, "billion"],
  [1e6, "million"],
  [1e3, "thousand"],
];

function underHundred(n: number): string {
  if (n < 20) return ONES[n];
  const tens = TENS[Math.floor(n / 10)];
  return n % 10 ? `${tens}-${ONES[n % 10]}` : tens;
}

function underThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (!hundreds) return underHundred(rest);
  return rest ? `${ONES[hundreds]} hundred ${underHundred(rest)}` : `${ONES[hundreds]} hundred`;
}

/** A whole number in words: 1234 → "one thousand two hundred thirty-four". */
export function numberWords(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `minus ${numberWords(-n)}`;
  n = Math.floor(n);
  if (n >= 1e15) return String(n).split("").map((d) => ONES[+d]).join(" ");
  const parts: string[] = [];
  for (const [size, name] of SCALES) {
    if (n >= size) {
      parts.push(`${underThousand(Math.floor(n / size))} ${name}`);
      n %= size;
    }
  }
  if (n || !parts.length) parts.push(underThousand(n));
  return parts.join(" ");
}

const ORDINAL_WORDS: Record<string, string> = {
  one: "first", two: "second", three: "third", five: "fifth", eight: "eighth",
  nine: "ninth", twelve: "twelfth",
};

/** 21 → "twenty-first". */
export function ordinalWords(n: number): string {
  const words = numberWords(n);
  const match = /([a-z]+)$/.exec(words)!;
  const last = match[1];
  const ordinal =
    ORDINAL_WORDS[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return words.slice(0, match.index) + ordinal;
}

/** A year as it is said: 1984 → "nineteen eighty-four", 2005 → "two thousand five". */
export function yearWords(n: number): string {
  if (n >= 2000 && n < 2010) return numberWords(n);
  const century = Math.floor(n / 100);
  const rest = n % 100;
  if (rest === 0) return `${numberWords(century)} hundred`;
  return `${numberWords(century)} ${rest < 10 ? `oh ${ONES[rest]}` : underHundred(rest)}`;
}

/** Digits after a decimal point, one by one: "14" → "one four". */
function digitWords(digits: string): string {
  return digits.split("").map((d) => ONES[+d]).join(" ");
}

/** A number as written, with thousands separators and decimals. */
function decimalWords(written: string): string {
  const [whole, fraction] = written.replace(/,/g, "").split(".");
  const words = numberWords(Number(whole || "0"));
  return fraction ? `${words} point ${digitWords(fraction)}` : words;
}

const CURRENCIES: Record<string, [string, string, string, string]> = {
  $: ["dollar", "dollars", "cent", "cents"],
  "£": ["pound", "pounds", "penny", "pence"],
  "€": ["euro", "euros", "cent", "cents"],
};
const MAGNITUDES: Record<string, string> = {
  k: "thousand", thousand: "thousand", m: "million", million: "million",
  bn: "billion", b: "billion", billion: "billion",
};

function moneyWords(symbol: string, written: string, magnitude: string | undefined): string {
  const [one, many, smallOne, smallMany] = CURRENCIES[symbol];
  const amount = written.replace(/,/g, "");
  if (magnitude) {
    return `${decimalWords(amount)} ${MAGNITUDES[magnitude.toLowerCase()]} ${many}`;
  }
  const [whole, fraction = ""] = amount.split(".");
  const units = Number(whole || "0");
  const small = fraction ? Number(fraction.padEnd(2, "0").slice(0, 2)) : 0;
  const unitPart = `${numberWords(units)} ${units === 1 ? one : many}`;
  const smallPart = `${numberWords(small)} ${small === 1 ? smallOne : smallMany}`;
  if (!small) return unitPart;
  return units ? `${unitPart} and ${smallPart}` : smallPart;
}

/** 10:05pm → "ten oh five P M", 3:00 → "three o'clock". */
function timeWords(hours: number, minutes: number, meridiem: string | undefined): string {
  let minute = "";
  if (minutes >= 10) minute = ` ${underHundred(minutes)}`;
  else if (minutes > 0) minute = ` oh ${ONES[minutes]}`;
  else if (!meridiem) minute = " o'clock";
  // Spaced letters, so it is said "P M" rather than read as a word.
  const suffix = meridiem ? ` ${meridiem.replace(/\./g, "").toUpperCase().split("").join(" ")}` : "";
  return `${numberWords(hours)}${minute}${suffix}`;
}

const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bMr\./g, "Mister"],
  [/\bMrs\./g, "Missus"],
  [/\bMs\./g, "Miz"],
  [/\bDr\./g, "Doctor"],
  [/\bvs\.?(?=\s)/gi, "versus"],
  [/\betc\./gi, "et cetera"],
  [/\be\.g\.,?/gi, "for example,"],
  [/\bi\.e\.,?/gi, "that is,"],
  [/\bNo\.\s*(?=\d)/g, "number "],
];

/** Not inside a word or number: what may stand before a number we read. */
const BEFORE = String.raw`(?<![\p{L}\d.,])`;
/** Nor run on into one. */
const AFTER = String.raw`(?![\p{L}\d])`;
const NUMBER = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;

const RULES: Array<[RegExp, (...m: string[]) => string]> = [
  // Money: $3.50, £20, €1.2m, $5 million.
  [
    new RegExp(String.raw`([$£€])\s?(${NUMBER})(?:\s?(k|m|bn|b|thousand|million|billion)\b)?`, "giu"),
    (_, symbol, amount, magnitude) => moneyWords(symbol, amount, magnitude),
  ],
  // Percentages: 50%, 2.5 %.
  [
    new RegExp(String.raw`${BEFORE}(${NUMBER})\s?%`, "gu"),
    (_, amount) => `${decimalWords(amount)} percent`,
  ],
  // Times: 3:45, 10:05pm, 7 a.m.
  [
    new RegExp(String.raw`${BEFORE}([01]?\d|2[0-3]):([0-5]\d)(?:\s?([ap]\.?m\.?))?${AFTER}`, "giu"),
    (_, h, m, meridiem) => timeWords(Number(h), Number(m), meridiem),
  ],
  [
    new RegExp(String.raw`${BEFORE}(1[0-2]|0?[1-9])\s?([ap]\.?m\.?)(?![\p{L}])`, "giu"),
    (_, h, meridiem) => timeWords(Number(h), 0, meridiem),
  ],
  // Ordinals: 1st, 22nd, 3rd, 11th.
  [
    new RegExp(String.raw`${BEFORE}(\d+)(?:st|nd|rd|th)${AFTER}`, "giu"),
    (_, n) => ordinalWords(Number(n)),
  ],
  // Decades: the 1980s, the '90s, the 80s.
  [
    new RegExp(String.raw`${BEFORE}(1[1-9]|20)?'?([1-9]0)'?s${AFTER}`, "gu"),
    (_, century, decade) => {
      const tens = TENS[Number(decade) / 10].replace(/y$/, "ies");
      return century ? `${numberWords(Number(century))} ${tens}` : tens;
    },
  ],
  // Ranges: 5-10, 1990–1995.
  [
    new RegExp(String.raw`${BEFORE}(\d+)\s?[-–]\s?(\d+)${AFTER}`, "gu"),
    (_, a, b) => `${wholeWords(a)} to ${wholeWords(b)}`,
  ],
  // Negative numbers, where a minus sign stands alone before the digits.
  [
    new RegExp(String.raw`(?<![\p{L}\d])-(${NUMBER})${AFTER}`, "gu"),
    (_, amount) => `minus ${decimalWords(amount)}`,
  ],
  // Everything else numeric, years read as years.
  [
    new RegExp(String.raw`${BEFORE}(${NUMBER})${AFTER}`, "gu"),
    (_, amount) => wholeWords(amount),
  ],
];

/** A number on its own: years as years, the rest as numbers. */
function wholeWords(written: string): string {
  if (/^\d{4}$/.test(written)) {
    const n = Number(written);
    if (n >= 1100 && n < 2100 && n % 1000 !== 0) return yearWords(n);
  }
  return decimalWords(written);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive replacement of each word with how it is said. */
function applyPronunciations(text: string, pronunciations: Record<string, string>): string {
  const words = Object.keys(pronunciations)
    .filter((w) => w.trim() && pronunciations[w].trim())
    .sort((a, b) => b.length - a.length);
  if (!words.length) return text;
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\d'])(${words.map((w) => escapeRegExp(w.trim())).join("|")})(?![\p{L}\d])`,
    "giu",
  );
  const lookup = new Map(words.map((w) => [w.trim().toLowerCase(), pronunciations[w].trim()]));
  return text.replace(pattern, (word) => lookup.get(word.toLowerCase()) ?? word);
}

function speakablePart(text: string, pronunciations: Record<string, string>): string {
  let out = applyPronunciations(text, pronunciations);
  for (const [pattern, replacement] of ABBREVIATIONS) out = out.replace(pattern, replacement);
  out = out.replace(/\s*&\s*/g, " and ");
  for (const [pattern, replace] of RULES) {
    out = out.replace(pattern, (...m) => replace(...(m as string[])));
  }
  return out;
}

/** `text` as a voice should read it; tags in square brackets pass untouched. */
export function speakable(text: string, pronunciations: Record<string, string> = {}): string {
  return text
    .split(/(\[[^\]]*\])/)
    .map((part, i) => (i % 2 ? part : speakablePart(part, pronunciations)))
    .join("")
    .replace(/[ \t]{2,}/g, " ");
}
