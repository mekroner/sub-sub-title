import { describe, expect, it } from "vitest";

import type { Edit, MediaInfo } from "../types";
import {
  addOverlayTrack,
  addSource,
  placeSource,
  placeText,
  setCanvas,
  setTransformAt,
  sourceFromInfo,
  startEditFromVideo,
} from "./edit";
import {
  base64ToBytes,
  bytesToBase64,
  instantiateTemplate,
  parseTemplate,
  serializeTemplate,
  templateCandidates,
  templateFrom,
} from "./template";

const info = (over: Partial<MediaInfo> = {}): MediaInfo => ({
  duration: 20,
  hasAudio: true,
  hasVideo: true,
  width: 1920,
  height: 1080,
  fps: 25,
  videoCodec: "h264",
  audioCodec: "aac",
  ...over,
});

const PNG = { name: "img-abc123.png", width: 200, height: 100, png: bytesToBase64(new Uint8Array([137, 80, 78, 71])) };

/** A logo on one overlay, outlined text above it, and a video overlay. */
function scene() {
  let edit = startEditFromVideo("/v/a.mp4", info());
  const logoTrack = addOverlayTrack(edit);
  const textTrack = addOverlayTrack(logoTrack.edit);
  edit = textTrack.edit;
  const logo = addSource(edit, sourceFromInfo("/v/logo.png", info({ width: 200, height: 100 }), "image"));
  edit = logo.edit;
  const placedLogo = placeSource(edit, logo.id, logoTrack.id, 5, "logo");
  edit = setTransformAt(placedLogo.edit, "logo", 0, { x: 0.8, y: 0.2, scale: 0.3 });
  edit = placeText(edit, textTrack.id, 6, "The end", "text").edit;
  const clip = placeSource(edit, edit.sources[0].id, logoTrack.id, 12, "clip");
  return { edit: clip.edit, logoSource: logo.id, logoTrack: logoTrack.id, textTrack: textTrack.id };
}

describe("templateFrom", () => {
  it("keeps overlay text and stills, their layering and their relative timing", () => {
    const { edit, logoSource } = scene();
    const ids = new Set(["logo", "text", "clip", edit.items[0].id]);
    expect(templateCandidates(edit, ids).skipped).toBe(2);
    const made = templateFrom(edit, ids, "Outro", new Map([[logoSource, PNG]]))!;
    expect(made.skipped).toBe(2);
    const t = made.template;
    expect(t).toMatchObject({ name: "Outro", canvas: { width: 1920, height: 1080 }, duration: 4 });
    expect(t.layers.map((l) => [l.lane, l.item.kind, l.item.start])).toEqual([
      [0, "image", 0],
      [1, "text", 1],
    ]);
    expect(t.layers[0].image).toBe("img-abc123.png");
    expect(t.layers[0].item.transform).toEqual([{ time: 0, x: 0.8, y: 0.2, scale: 0.3 }]);
    expect(Object.keys(t.images)).toEqual(["img-abc123.png"]);
    expect("id" in t.layers[1].item).toBe(false);
  });

  it("makes nothing from nothing usable", () => {
    const { edit } = scene();
    expect(templateFrom(edit, new Set(["clip"]), "x", new Map())).toBeNull();
  });
});

describe("parse and insert", () => {
  function saved() {
    const { edit, logoSource } = scene();
    return parseTemplate(serializeTemplate(templateFrom(edit, new Set(["logo", "text"]), "Outro", new Map([[logoSource, PNG]]))!.template));
  }

  it("round-trips through the file", () => {
    const t = saved();
    expect(t.layers).toHaveLength(2);
    expect(t.images["img-abc123.png"].png).toBe(PNG.png);
    expect(Array.from(base64ToBytes(t.images["img-abc123.png"].png))).toEqual([137, 80, 78, 71]);
  });

  it("refuses files with nothing to insert", () => {
    expect(() => parseTemplate("nope")).toThrow(/JSON/);
    expect(() => parseTemplate(JSON.stringify({ layers: [{ lane: 0, item: { kind: "image" } }] }))).toThrow(/nothing/);
  });

  it("places the template on free tracks, in order, and rescales text for the canvas", () => {
    const template = saved();
    let edit: Edit = setCanvas(startEditFromVideo("/v/b.mp4", info()), { width: 1280, height: 720, fps: 25 });
    let n = 0;
    const ids = () => `id${++n}`;
    const placed = instantiateTemplate(edit, template, 5, new Map([["img-abc123.png", "/p/assets/img-abc123.png"]]), ids);
    edit = placed.edit;
    // Two new overlay tracks on top, the logo's below the text's.
    expect(edit.tracks.map((t) => t.kind)).toEqual(["main", "overlay", "overlay"]);
    const [logo, text] = placed.itemIds.map((id) => edit.items.find((i) => i.id === id)!);
    expect(logo).toMatchObject({ kind: "image", start: 5, trackId: edit.tracks[1].id });
    expect(text).toMatchObject({ kind: "text", start: 6, trackId: edit.tracks[2].id });
    expect(text.kind === "text" && text.style.fontSize).toBe(48);
    expect(edit.sources.find((s) => s.kind === "image")).toMatchObject({ path: "/p/assets/img-abc123.png", width: 200 });

    // Again at the same time: those tracks are busy, so two more go on top.
    const again = instantiateTemplate(edit, template, 5, new Map([["img-abc123.png", "/p/assets/img-abc123.png"]]), ids);
    expect(again.edit.tracks).toHaveLength(5);
    expect(again.edit.sources.filter((s) => s.kind === "image")).toHaveLength(1);
    // Later, the first two are free again and reused.
    const later = instantiateTemplate(edit, template, 30, new Map([["img-abc123.png", "/p/a.png"]]), ids);
    expect(later.edit.tracks).toHaveLength(3);
  });
});
