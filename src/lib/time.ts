/** Timecode formatting and parsing. All internal times are seconds. */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parts(seconds: number) {
  const safe = Math.max(0, seconds);
  const totalMs = Math.round(safe * 1000);
  return {
    h: Math.floor(totalMs / 3_600_000),
    m: Math.floor(totalMs / 60_000) % 60,
    s: Math.floor(totalMs / 1000) % 60,
    ms: totalMs % 1000,
  };
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** SRT timecode: `00:01:23,456`. */
export function formatSrtTime(seconds: number): string {
  const { h, m, s, ms } = parts(seconds);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** ASS timecode: `0:01:23.45` (centiseconds, single-digit hours). */
export function formatAssTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const totalCs = Math.round(safe * 100);
  const h = Math.floor(totalCs / 360_000);
  const m = Math.floor(totalCs / 6_000) % 60;
  const s = Math.floor(totalCs / 100) % 60;
  const cs = totalCs % 100;
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

/** Compact display for the cue list and waveform: `1:23.45`. */
export function formatShort(seconds: number): string {
  const { h, m, s, ms } = parts(seconds);
  const base = `${h > 0 ? `${h}:${pad(m)}` : m}:${pad(s)}.${pad(Math.floor(ms / 10))}`;
  return base;
}

/**
 * Accepts `00:01:23,456`, `00:01:23.456`, `01:23.4`, or a bare number of
 * seconds, so the cue list can take hand-typed timecodes.
 */
export function parseTimecode(input: string): number | null {
  const text = input.trim().replace(",", ".");
  if (!text) return null;

  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);

  const m = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return null;

  const [, h, mm, ss] = m;
  const value = (h ? Number(h) * 3600 : 0) + Number(mm) * 60 + Number(ss);
  return Number.isFinite(value) ? value : null;
}

export function formatDuration(seconds: number): string {
  const { h, m, s } = parts(seconds);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Reading speed in characters per second — the standard readability check.
 * Newlines do not count as characters.
 */
export function charsPerSecond(text: string, start: number, end: number): number {
  const duration = end - start;
  if (duration <= 0) return Infinity;
  return text.replace(/\s+/g, " ").trim().length / duration;
}
