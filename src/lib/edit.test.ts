import { describe, expect, it } from "vitest";

import type { Edit, EditItem, MediaInfo, VideoItem } from "../types";
import {
  MAIN_TRACK_ID,
  addOverlayTrack,
  addSource,
  alphaAt,
  audioGainAt,
  canvasFor,
  coerceEdit,
  editEnd,
  freeStart,
  itemsAt,
  mainTrackOverlaps,
  moveItem,
  moveTrack,
  naturalSize,
  overlayTarget,
  patchTextStyle,
  placeSource,
  placeText,
  removeItem,
  resolveRect,
  setCanvas,
  setFade,
  setStaticTransform,
  setText,
  sourceFromInfo,
  splitItem,
  startEditFromVideo,
  transformAt,
  trimItemEnd,
  trimItemStart,
} from "./edit";
import { parseProjectFile, serializeProjectFile } from "./projectFile";
import { defaultVoiceover } from "./voiceover";

const info = (over: Partial<MediaInfo> = {}): MediaInfo => ({
  duration: 10,
  hasAudio: true,
  hasVideo: true,
  width: 1920,
  height: 1080,
  fps: 25,
  videoCodec: "h264",
  audioCodec: "aac",
  ...over,
});

/** An edit from a 10 s source, plus a second 6 s source not yet placed. */
function twoSources(): { edit: Edit; a: string; b: string } {
  let edit = startEditFromVideo("/v/a.mp4", info());
  const added = addSource(edit, sourceFromInfo("/v/b.mp4", info({ duration: 6 }), "video"));
  edit = added.edit;
  return { edit, a: edit.sources[0].id, b: added.id };
}

const main = (edit: Edit) =>
  edit.items.filter((i) => i.trackId === MAIN_TRACK_ID).sort((x, y) => x.start - y.start);

describe("startEditFromVideo", () => {
  it("cuts the whole video onto the main track at the source's size", () => {
    const edit = startEditFromVideo("/v/a.mp4", info({ width: 1279, height: 721, fps: 29.97 }));
    expect(edit.canvas).toEqual({ width: 1280, height: 722, fps: 29.97 });
    expect(edit.tracks.map((t) => t.kind)).toEqual(["main"]);
    expect(edit.items).toHaveLength(1);
    const item = edit.items[0] as VideoItem;
    expect(item).toMatchObject({ kind: "video", start: 0, duration: 10, offset: 0, gainDb: 0 });
    expect(item.transform).toEqual([{ time: 0, x: 0.5, y: 0.5, scale: 1 }]);
  });

  it("does not add the same file twice as a source", () => {
    const edit = startEditFromVideo("/v/a.mp4", info());
    const again = addSource(edit, sourceFromInfo("/v/a.mp4", info(), "video"));
    expect(again.edit).toBe(edit);
    expect(again.id).toBe(edit.sources[0].id);
  });
});

describe("main-track placement", () => {
  it("places a new clip in the nearest gap that fits, never overlapping", () => {
    const { edit, b } = twoSources();
    // Asked for 4 s, inside the first clip: the nearest free start is its end.
    const placed = placeSource(edit, b, MAIN_TRACK_ID, 4);
    expect(main(placed.edit).map((i) => [i.start, i.duration])).toEqual([
      [0, 10],
      [10, 6],
    ]);
    expect(mainTrackOverlaps(placed.edit).size).toBe(0);
  });

  it("moves a clip into a gap wide enough, or past the others", () => {
    const { edit: e0, b } = twoSources();
    let edit = placeSource(e0, b, MAIN_TRACK_ID, 20).edit; // [0,10] gap [20,26]
    const second = main(edit)[1];
    expect(second.start).toBe(20);
    // A 6 s clip asked to start at 12 fits in the gap.
    edit = moveItem(edit, second.id, 12);
    expect(main(edit)[1].start).toBe(12);
    // Dragged onto the first clip, it lands against its end.
    edit = moveItem(edit, second.id, 3);
    expect(main(edit)[1].start).toBe(10);
    expect(mainTrackOverlaps(edit).size).toBe(0);
  });

  it("lets overlay items overlap", () => {
    const { edit: e0 } = twoSources();
    const { edit: e1, id: track } = addOverlayTrack(e0);
    const t1 = placeText(e1, track, 1);
    const t2 = placeText(t1.edit, track, 2);
    expect(t2.edit.items.find((i) => i.id === t2.id)!.start).toBe(2);
    expect(freeStart(t2.edit, track, -3, 1)).toBe(0);
  });
});

describe("trimming", () => {
  it("cannot reveal more of a video than the source holds", () => {
    const { edit: e0 } = twoSources();
    const id = e0.items[0].id;
    let edit = trimItemStart(e0, id, 2);
    expect(edit.items[0]).toMatchObject({ start: 2, duration: 8, offset: 2 });
    // Back past the source's head: stops where offset reaches 0.
    edit = trimItemStart(edit, id, -5);
    expect(edit.items[0]).toMatchObject({ start: 0, duration: 10, offset: 0 });
    edit = trimItemEnd(edit, id, 30);
    expect(edit.items[0].duration).toBe(10);
  });

  it("stops at the neighbouring main-track clip", () => {
    const { edit: e0, b } = twoSources();
    let edit = trimItemEnd(e0, e0.items[0].id, 8);
    edit = placeSource(edit, b, MAIN_TRACK_ID, 8).edit; // [0,8] [8,14]
    edit = trimItemEnd(edit, main(edit)[0].id, 9.5);
    expect(main(edit)[0].duration).toBe(8);
    // The second clip trimmed back from 3 s in stops at the first's end.
    edit = trimItemStart(edit, main(edit)[1].id, 11);
    edit = trimItemStart(edit, main(edit)[1].id, 2);
    expect(main(edit)[1]).toMatchObject({ start: 8, offset: 0 });
  });

  it("keeps the fades inside a trimmed clip", () => {
    const { edit: e0 } = twoSources();
    const id = e0.items[0].id;
    let edit = setFade(e0, id, "in", 3);
    edit = setFade(edit, id, "out", 4);
    edit = trimItemEnd(edit, id, 5);
    const item = edit.items[0];
    expect(item.fadeIn).toBe(3);
    expect(item.fadeOut).toBe(2);
    expect(setFade(edit, id, "out", 9).items[0].fadeOut).toBe(2);
  });
});

describe("splitItem", () => {
  it("cuts a clip in two, the second half later in the source", () => {
    const { edit: e0 } = twoSources();
    let edit = setFade(e0, e0.items[0].id, "in", 1);
    edit = setFade(edit, e0.items[0].id, "out", 1);
    const split = splitItem(edit, e0.items[0].id, 4);
    const [left, right] = main(split.edit) as VideoItem[];
    expect(left).toMatchObject({ start: 0, duration: 4, offset: 0, fadeIn: 1, fadeOut: 0 });
    expect(right).toMatchObject({ start: 4, duration: 6, offset: 4, fadeIn: 0, fadeOut: 1 });
    expect(right.id).toBe(split.id);
  });

  it("refuses a cut at or too near an edge", () => {
    const { edit } = twoSources();
    expect(splitItem(edit, edit.items[0].id, 0).id).toBeNull();
    expect(splitItem(edit, edit.items[0].id, 10).edit).toBe(edit);
  });

  it("carries motion across the cut", () => {
    const { edit: e0 } = twoSources();
    const item = e0.items[0];
    const moving: EditItem = {
      ...item,
      transform: [
        { time: 0, x: 0.5, y: 0.5, scale: 1 },
        { time: 10, x: 0.5, y: 0.5, scale: 2 },
      ],
    };
    const split = splitItem({ ...e0, items: [moving] }, item.id, 5);
    const [left, right] = main(split.edit);
    expect(left.transform[left.transform.length - 1]).toEqual({ time: 5, x: 0.5, y: 0.5, scale: 1.5 });
    expect(right.transform[0]).toEqual({ time: 0, x: 0.5, y: 0.5, scale: 1.5 });
    expect(right.transform[1].time).toBe(5);
  });
});

describe("drawing maths", () => {
  it("interpolates transforms linearly and holds the ends", () => {
    const keys = [
      { time: 1, x: 0, y: 0, scale: 1 },
      { time: 3, x: 1, y: 0.5, scale: 2 },
    ];
    expect(transformAt(keys, 0)).toMatchObject({ x: 0, scale: 1 });
    expect(transformAt(keys, 2)).toMatchObject({ x: 0.5, y: 0.25, scale: 1.5 });
    expect(transformAt(keys, 9)).toMatchObject({ x: 1, scale: 2 });
  });

  it("fits video inside the canvas and resolves to whole pixels", () => {
    const edit = startEditFromVideo("/v/a.mp4", info());
    const portrait = sourceFromInfo("/v/p.mp4", info({ width: 1080, height: 1920 }), "video");
    const size = naturalSize(edit.items[0], edit.canvas, portrait)!;
    expect(size.height).toBe(1080);
    expect(size.width).toBeCloseTo(607.5);
    const rect = resolveRect(size, { time: 0, x: 0.5, y: 0.5, scale: 1 }, edit.canvas);
    expect(rect).toEqual({ x: 656, y: 0, w: 608, h: 1080 });
    const half = resolveRect({ width: 1920, height: 1080 }, { time: 0, x: 0.25, y: 0.75, scale: 0.5 }, edit.canvas);
    expect(half).toEqual({ x: 0, y: 540, w: 960, h: 540 });
  });

  it("ramps alpha and audio through the fades, scaled by opacity and gain", () => {
    const { edit: e0 } = twoSources();
    let edit = setFade(e0, e0.items[0].id, "in", 2);
    edit = setFade(edit, e0.items[0].id, "out", 4);
    const item = { ...edit.items[0], opacity: 0.5, gainDb: 6 } as VideoItem;
    expect(alphaAt(item, 0)).toBe(0);
    expect(alphaAt(item, 1)).toBeCloseTo(0.25);
    expect(alphaAt(item, 5)).toBe(0.5);
    expect(alphaAt(item, 8)).toBeCloseTo(0.25);
    expect(alphaAt(item, 11)).toBe(0);
    expect(audioGainAt(item, 5)).toBeCloseTo(1.995, 2);
    expect(audioGainAt(item, 1)).toBeCloseTo(0.998, 2);
  });

  it("lists what shows at a moment, bottom layer first, skipping hidden tracks", () => {
    const { edit: e0 } = twoSources();
    const { edit: e1, id: track } = addOverlayTrack(e0);
    const { edit } = placeText(e1, track, 1);
    expect(itemsAt(edit, 1.5).map((i) => i.kind)).toEqual(["video", "text"]);
    const hidden = { ...edit, tracks: edit.tracks.map((t) => (t.id === track ? { ...t, hidden: true } : t)) };
    expect(itemsAt(hidden, 1.5).map((i) => i.kind)).toEqual(["video"]);
    expect(editEnd(edit)).toBe(10);
    expect(editEnd(removeItem(edit, edit.items[0].id))).toBe(4);
  });
});

describe("setCanvas", () => {
  it("keeps sizes even and scales text with the height", () => {
    const { edit: e0 } = twoSources();
    const { edit: e1, id: track } = addOverlayTrack(e0);
    const { edit } = placeText(e1, track, 0);
    const next = setCanvas(edit, { width: 1281, height: 720, fps: 25 });
    expect(next.canvas).toEqual({ width: 1282, height: 720, fps: 25 });
    const text = next.items.find((i) => i.kind === "text")!;
    expect(text.kind === "text" && text.style.fontSize).toBe(48);
    expect(text.kind === "text" && text.style.outline?.width).toBeCloseTo(2.67, 2);
    expect(setCanvas(next, next.canvas)).toBe(next);
  });

  it("derives a canvas from a probe", () => {
    expect(canvasFor({ width: 0, height: 0, fps: Number.NaN })).toEqual({ width: 1920, height: 1080, fps: 30 });
  });
});

describe("project file", () => {
  const base = {
    videoPath: "/v/a.mp4",
    cues: [],
    speakers: [],
    dictionary: [],
    brief: "",
    beats: [],
    sections: [],
    timedBeats: [],
    voiceover: defaultVoiceover(),
  };

  it("leaves an absent edit absent", () => {
    const parsed = parseProjectFile(serializeProjectFile(base));
    expect("edit" in parsed).toBe(false);
  });

  it("round-trips an edit", () => {
    const { edit: e0, b } = twoSources();
    const { edit: e1, id: track } = addOverlayTrack(placeSource(e0, b, MAIN_TRACK_ID, 12).edit);
    const edit: Edit = {
      ...placeText(e1, track, 2, "Hello").edit,
      baked: { path: "/v/a.cut.mp4", planHash: "abc", at: "2026-10-31T00:00:00.000Z" },
    };
    const parsed = parseProjectFile(serializeProjectFile({ ...base, edit }));
    expect(parsed.edit).toEqual(edit);
  });

  it("drops items whose source or track is missing, and always has one main track", () => {
    const edit = coerceEdit({
      canvas: { width: 640, height: 360, fps: 30 },
      sources: [{ id: "s", path: "/v/a.mp4", kind: "video", width: 640, height: 360, duration: 5 }],
      tracks: [{ id: "o", kind: "overlay", name: "Top" }],
      items: [
        { id: "ok", kind: "video", trackId: "main", sourceId: "s", start: 0, duration: 9, transform: [] },
        { id: "nosource", kind: "video", trackId: "main", sourceId: "x", start: 0, duration: 1 },
        { id: "notrack", kind: "text", trackId: "gone", start: 0, duration: 1 },
        "nonsense",
      ],
    })!;
    expect(edit.tracks.map((t) => t.id)).toEqual(["main", "o"]);
    expect(edit.items.map((i) => i.id)).toEqual(["ok"]);
    // Clamped to what the source holds, and given a default transform.
    expect(edit.items[0]).toMatchObject({ duration: 5, opacity: 1, transform: [{ time: 0, x: 0.5, y: 0.5, scale: 1 }] });
    expect(coerceEdit("nope")).toBeUndefined();
  });
});

describe("overlays", () => {
  it("finds the topmost overlay track free at the time, adding one when none is", () => {
    const { edit: e0 } = twoSources();
    const first = overlayTarget(e0, 1, 3);
    expect(first.edit.tracks.map((t) => t.kind)).toEqual(["main", "overlay"]);
    const { edit: e2, id: top } = addOverlayTrack(first.edit);
    const again = overlayTarget(e2, 1, 3);
    expect(again.edit).toBe(e2);
    expect(again.trackId).toBe(top);
    // Something already there: the next track down if it is free, else a new one.
    const busy = placeText(e2, top, 1).edit;
    expect(overlayTarget(busy, 2, 3).trackId).toBe(first.trackId);
    const full = placeText(busy, first.trackId, 0).edit;
    const added = overlayTarget(full, 2, 3);
    expect(added.edit.tracks).toHaveLength(4);
    // After it ends, the top track is free again.
    expect(overlayTarget(full, 4, 1).trackId).toBe(top);
  });

  it("reorders overlay tracks but never moves the main track", () => {
    const { edit: e0 } = twoSources();
    const { edit: e1, id: a } = addOverlayTrack(e0);
    const { edit: e2, id: b } = addOverlayTrack(e1);
    expect(moveTrack(e2, a, 1).tracks.map((t) => t.id)).toEqual([MAIN_TRACK_ID, b, a]);
    expect(moveTrack(e2, a, -1)).toBe(e2);
    expect(moveTrack(e2, b, 1)).toBe(e2);
    expect(moveTrack(e2, MAIN_TRACK_ID, 1)).toBe(e2);
  });

  it("keeps text off the main track", () => {
    const { edit: e0 } = twoSources();
    expect(placeText(e0, MAIN_TRACK_ID, 0).id).toBeNull();
    const { edit: e1, id: track } = addOverlayTrack(e0);
    const { edit, id } = placeText(e1, track, 1);
    expect(moveItem(edit, id!, 2, MAIN_TRACK_ID).items.find((i) => i.id === id)).toMatchObject({
      trackId: track,
      start: 2,
    });
    // An image may go either way.
    const image = addSource(edit, sourceFromInfo("/v/logo.png", info({ duration: 0 }), "image"));
    const placed = placeSource(image.edit, image.id, track, 0);
    const moved = moveItem(placed.edit, placed.id!, 20, MAIN_TRACK_ID);
    expect(moved.items.find((i) => i.id === placed.id)).toMatchObject({ trackId: MAIN_TRACK_ID, start: 20 });
  });
});

describe("static transforms and text", () => {
  it("moves and sizes a single-key item, clamping the scale", () => {
    const { edit: e0 } = twoSources();
    const id = e0.items[0].id;
    const edit = setStaticTransform(e0, id, { x: 0.25, scale: 0 });
    expect(edit.items[0].transform).toEqual([{ time: 0, x: 0.25, y: 0.5, scale: 0.01 }]);
    expect(setStaticTransform(edit, id, { x: 0.25 })).toBe(edit);
  });

  it("leaves an animated item to be edited key by key", () => {
    const { edit: e0 } = twoSources();
    const animated: Edit = {
      ...e0,
      items: [{ ...e0.items[0], transform: [{ time: 0, x: 0.5, y: 0.5, scale: 1 }, { time: 2, x: 0.5, y: 0.5, scale: 2 }] }],
    };
    expect(setStaticTransform(animated, e0.items[0].id, { x: 0 })).toBe(animated);
  });

  it("changes words and looks, and takes effects away with null", () => {
    const { edit: e0 } = twoSources();
    const { edit: e1, id: track } = addOverlayTrack(e0);
    const { edit: e2, id } = placeText(e1, track, 0);
    let edit = setText(e2, id!, "Hello\nworld");
    edit = patchTextStyle(edit, id!, { fontSize: 0, outline: null, shadow: { color: "#000", blur: 4, dx: 2, dy: 2 } });
    const text = edit.items.find((i) => i.id === id)!;
    expect(text.kind === "text" && text.text).toBe("Hello\nworld");
    expect(text.kind === "text" && text.style).toMatchObject({ fontSize: 1, shadow: { blur: 4 } });
    expect(text.kind === "text" && "outline" in text.style).toBe(false);
    // Not a text item: nothing happens.
    expect(setText(edit, edit.items[0].id, "x")).toBe(edit);
  });
});
