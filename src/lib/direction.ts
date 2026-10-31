/**
 * Direction for generated speech: the tags Chatterbox Turbo understands, and
 * turning a free-text note like "whispered, close to tears" into them — or,
 * for the Expressive model, into an intensity.
 *
 * The tag list is Turbo's own: the added tokens in its tokenizer. Anything
 * else in square brackets is spoken as text, so nothing outside this list is
 * offered.
 */

/** Sounds, placed where they happen in the line. */
export const SOUND_TAGS = [
  "[laugh]",
  "[chuckle]",
  "[sigh]",
  "[gasp]",
  "[groan]",
  "[cough]",
  "[sniff]",
  "[clear throat]",
  "[shush]",
] as const;

/** Delivery, usually at the start of a line. */
export const DELIVERY_TAGS = [
  "[whispering]",
  "[crying]",
  "[angry]",
  "[fear]",
  "[happy]",
  "[surprised]",
  "[sarcastic]",
  "[dramatic]",
  "[narration]",
  "[advertisement]",
] as const;

export const TURBO_TAGS: readonly string[] = [...SOUND_TAGS, ...DELIVERY_TAGS];

/** A known tag, case-insensitively, with its inner spacing as Turbo has it. */
const TAG_PATTERN = new RegExp(
  `\\[(?:${TURBO_TAGS.map((t) => t.slice(1, -1).replace(/ /g, "\\s+")).join("|")})\\]`,
  "gi",
);

/** Words in a direction note and the delivery tag each implies. */
const DELIVERY_WORDS: Array<[RegExp, string]> = [
  [/\bwhisper/i, "[whispering]"],
  [/\b(cry|crying|sob|tearful|tears|weep)/i, "[crying]"],
  [/\b(angry|anger|furious|rage|shout|yell|scream|snarl)/i, "[angry]"],
  [/\b(afraid|scared|fear|terrified|frightened|panick?)/i, "[fear]"],
  [/\b(happy|cheerful|joy|delighted|bright|warm)/i, "[happy]"],
  [/\b(surprise|shocked|astonished|startled)/i, "[surprised]"],
  [/\b(sarcas|dry|deadpan|mocking|ironic)/i, "[sarcastic]"],
  [/\b(dramatic|theatrical|grand)/i, "[dramatic]"],
  [/\b(narrat)/i, "[narration]"],
];

/** Words that mean a sound at the start of the line. */
const SOUND_WORDS: Array<[RegExp, string]> = [
  [/\blaugh/i, "[laugh]"],
  [/\bchuckl/i, "[chuckle]"],
  [/\bsigh/i, "[sigh]"],
  [/\bgasp/i, "[gasp]"],
  [/\b(groan|moan)/i, "[groan]"],
  [/\bcough/i, "[cough]"],
  [/\b(sniff|sniffl)/i, "[sniff]"],
  [/\bclears? (?:his |her |their )?throat/i, "[clear throat]"],
];

/** Tags a direction note implies: delivery first, then sounds. */
export function directionTags(direction: string): string[] {
  const tags: string[] = [];
  for (const [pattern, tag] of [...DELIVERY_WORDS, ...SOUND_WORDS]) {
    if (pattern.test(direction) && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/**
 * The Expressive model's intensity a direction implies, or null to keep the
 * voice's own. Restrained words pull it down, heated ones push it up; when
 * both appear, the heated ones win, since they are the harder to hear.
 */
export function directionIntensity(direction: string): number | null {
  if (/\b(scream|shriek|hysteric|furious|rage|frantic)/i.test(direction)) return 1.6;
  if (/\b(shout|yell|angry|excited|intense|dramatic|theatrical|passionate|terrified)/i.test(direction)) {
    return 1.2;
  }
  if (/\b(whisper|quiet|soft|calm|flat|monotone|tired|weary|deadpan|gentle|murmur)/i.test(direction)) {
    return 0.3;
  }
  return null;
}

/** Removes every Turbo tag, for a model that would read them aloud. */
export function stripTags(text: string): string {
  return text.replace(TAG_PATTERN, " ").replace(/\s+/g, " ").trim();
}

/** Whether the text already carries this tag, however it is spaced or cased. */
export function hasTag(text: string, tag: string): boolean {
  return new RegExp(tag.replace(/[[\]]/g, "\\$&").replace(/ /g, "\\s+"), "i").test(text);
}

/** Inserts `tag` at `caret`, with a space either side where needed. */
export function insertTag(
  text: string,
  caret: number,
  tag: string,
): { text: string; caret: number } {
  const at = Math.max(0, Math.min(text.length, caret));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before === "" || /\s$/.test(before) ? "" : " ";
  const trail = after === "" || /^\s/.test(after) ? "" : " ";
  const inserted = `${lead}${tag}${trail}`;
  return { text: before + inserted + after, caret: at + lead.length + tag.length + trail.length };
}
