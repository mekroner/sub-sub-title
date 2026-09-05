import { describe, expect, it } from "vitest";
import {
  AUTO_DETECT,
  WHISPER_LANGUAGES,
  WHISPER_MODELS,
  DEFAULT_WHISPER_MODEL,
  formatBytes,
  formatEta,
  modelSize,
} from "./whisper";

describe("whisper choices", () => {
  it("offers auto-detect first, so it is the default a user falls into", () => {
    expect(WHISPER_LANGUAGES[0].code).toBe(AUTO_DETECT);
  });

  it("has no duplicate language or model ids", () => {
    const codes = WHISPER_LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    const ids = WHISPER_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("can resolve the default model", () => {
    expect(WHISPER_MODELS.some((m) => m.id === DEFAULT_WHISPER_MODEL)).toBe(true);
    expect(modelSize(DEFAULT_WHISPER_MODEL)).not.toBe("");
  });

  it("degrades to the raw id for a model it does not know", () => {
    expect(modelSize("large-v9")).toBe("");
  });
});

describe("formatBytes", () => {
  it("scales to the unit that reads naturally", () => {
    expect(formatBytes(1_424_256_246)).toBe("1.3 GB");
    expect(formatBytes(480 * 1024 * 1024)).toBe("480 MB");
    expect(formatBytes(2048)).toBe("2 KB");
  });
});

describe("formatEta", () => {
  it("phrases the wait in the largest useful unit", () => {
    expect(formatEta(42)).toBe("42 s left");
    expect(formatEta(200)).toBe("3 min left");
    expect(formatEta(3 * 3600 + 25 * 60)).toBe("3 h 25 min left");
  });

  it("returns null when there is no estimate yet", () => {
    // -1 is the backend's "unknown"; a bar showing "-1 s left" is worse than
    // showing nothing.
    expect(formatEta(-1)).toBeNull();
    expect(formatEta(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
