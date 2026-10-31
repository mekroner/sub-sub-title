import { describe, expect, it } from "vitest";

import {
  directionIntensity,
  directionTags,
  hasTag,
  insertTag,
  stripTags,
} from "./direction";

describe("directionTags", () => {
  it("turns delivery words into tags, delivery before sounds", () => {
    expect(directionTags("laughing, whispered")).toEqual(["[whispering]", "[laugh]"]);
    expect(directionTags("close to tears")).toEqual(["[crying]"]);
    expect(directionTags("Dry. Deadpan.")).toEqual(["[sarcastic]"]);
  });

  it("maps moans to the nearest sound Turbo has", () => {
    expect(directionTags("a low moan")).toEqual(["[groan]"]);
  });

  it("finds nothing in a note it does not understand", () => {
    expect(directionTags("slowly, like she means it")).toEqual([]);
  });
});

describe("directionIntensity", () => {
  it("pulls restraint down and heat up, heat winning", () => {
    expect(directionIntensity("quiet, tired")).toBe(0.3);
    expect(directionIntensity("shouting")).toBe(1.2);
    expect(directionIntensity("screaming")).toBe(1.6);
    expect(directionIntensity("quiet but furious")).toBe(1.6);
    expect(directionIntensity("slowly")).toBeNull();
  });
});

describe("tags in text", () => {
  it("strips only Turbo's tags, whatever their case and spacing", () => {
    expect(stripTags("[Laugh] Oh no. [clear  throat] Well [sic].")).toBe("Oh no. Well [sic].");
  });

  it("recognises a tag already present", () => {
    expect(hasTag("[WHISPERING] hi", "[whispering]")).toBe(true);
    expect(hasTag("[clear  throat] hi", "[clear throat]")).toBe(true);
    expect(hasTag("hi", "[laugh]")).toBe(false);
  });

  it("inserts at the caret with sensible spacing", () => {
    expect(insertTag("Oh no.", 0, "[gasp]")).toEqual({ text: "[gasp] Oh no.", caret: 7 });
    expect(insertTag("Oh no.", 6, "[sigh]")).toEqual({ text: "Oh no. [sigh]", caret: 13 });
    expect(insertTag("Oh no.", 3, "[gasp]").text).toBe("Oh [gasp] no.");
    expect(insertTag("", 0, "[laugh]")).toEqual({ text: "[laugh]", caret: 7 });
  });
});
