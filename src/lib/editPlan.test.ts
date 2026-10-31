import { describe, expect, it } from "vitest";

import type { MediaInfo } from "../types";
import {
  MAIN_TRACK_ID,
  addOverlayTrack,
  addSource,
  patchItem,
  patchTrack,
  placeSource,
  placeText,
  setFade,
  sourceFromInfo,
  startEditFromVideo,
  trimItemEnd,
} from "./edit";
import { bakeBase, buildRenderPlan, nextBakePath, planHash, samePath } from "./editPlan";

const info = (over: Partial<MediaInfo> = {}): MediaInfo => ({
  duration: 10,
  hasAudio: true,
  hasVideo: true,
  width: 1280,
  height: 720,
  fps: 25,
  videoCodec: "h264",
  audioCodec: "aac",
  ...over,
});

/** Three clips from two sources, with a gap and dips to black. */
function fixture() {
  let edit = startEditFromVideo("/v/a.mp4", info());
  const first = edit.items[0].id;
  edit = trimItemEnd(edit, first, 4);
  edit = setFade(edit, first, "out", 0.5);
  const b = addSource(edit, sourceFromInfo("/v/b.mp4", info({ duration: 6, hasAudio: false }), "video"));
  edit = b.edit;
  const second = placeSource(edit, b.id, MAIN_TRACK_ID, 5);
  edit = setFade(second.edit, second.id!, "in", 0.5);
  const third = placeSource(edit, edit.sources[0].id, MAIN_TRACK_ID, 11);
  edit = third.edit;
  return edit;
}

describe("buildRenderPlan", () => {
  it("lays out main-track clips with their gaps, fades and audio", () => {
    const plan = buildRenderPlan(fixture());
    expect(plan).toMatchObject({ width: 1280, height: 720, fps: 25, total: 21 });
    expect(plan.layers.map((l) => [l.start, l.duration, l.offset])).toEqual([
      [0, 4, 0],
      [5, 6, 0],
      [11, 10, 0],
    ]);
    expect(plan.layers[0]).toMatchObject({ path: "/v/a.mp4", fadeOut: 0.5, audio: { gainDb: 0 } });
    // The second source has no audio track.
    expect(plan.layers[1].audio).toBeUndefined();
    expect(plan.layers[1].rects).toEqual([{ time: 0, x: 0, y: 0, w: 1280, h: 720 }]);
  });

  it("silences a muted main track and skips hidden ones", () => {
    let edit = fixture();
    edit = patchTrack(edit, MAIN_TRACK_ID, { muted: true });
    expect(buildRenderPlan(edit).layers.every((l) => !l.audio)).toBe(true);
    edit = patchTrack(edit, MAIN_TRACK_ID, { hidden: true });
    expect(buildRenderPlan(edit).layers).toHaveLength(0);
    // The timeline is as long as before: hidden is not deleted.
    expect(buildRenderPlan(edit).total).toBe(21);
  });

  it("draws overlays above the main track, text only once rasterised", () => {
    const { edit: e1, id: track } = addOverlayTrack(fixture());
    const { edit, id } = placeText(e1, track, 1);
    expect(buildRenderPlan(edit).layers).toHaveLength(3);
    const plan = buildRenderPlan(edit, new Map([[id!, { name: "t1.png", width: 200, height: 80 }]]));
    expect(plan.layers[plan.layers.length - 1]).toMatchObject({
      kind: "image",
      path: "t1.png",
      staged: true,
      rects: [{ time: 0, x: 540, y: 320, w: 200, h: 80 }],
    });
    expect(plan.layers[plan.layers.length - 1].audio).toBeUndefined();
  });
});

describe("planHash", () => {
  it("is stable for the same edit and changes with it", () => {
    const edit = fixture();
    const hash = planHash(buildRenderPlan(edit));
    expect(planHash(buildRenderPlan(fixture()))).toBe(hash);
    const faded = patchItem(edit, edit.items[0].id, { opacity: 0.9 });
    expect(planHash(buildRenderPlan(faded))).not.toBe(hash);
  });

  it("changes when the drawn text does", () => {
    const { edit: e1, id: track } = addOverlayTrack(fixture());
    const { edit, id } = placeText(e1, track, 1);
    const hashWith = (name: string) =>
      planHash(buildRenderPlan(edit, new Map([[id!, { name, width: 200, height: 80 }]])));
    expect(hashWith("t-abc.png")).toBe(hashWith("t-abc.png"));
    expect(hashWith("t-abc.png")).not.toBe(hashWith("t-def.png"));
  });

  it("ignores float noise below a microsecond", () => {
    const plan = buildRenderPlan(fixture());
    const noisy = { ...plan, layers: plan.layers.map((l) => ({ ...l, start: l.start + 1e-9 })) };
    expect(planHash(noisy)).toBe(planHash(plan));
  });
});

describe("bake naming", () => {
  it("names the bake after the project, beside it", () => {
    const edit = fixture();
    expect(bakeBase("C:\\work\\Film.sstproj", edit)).toEqual({ dir: "C:\\work", stem: "Film", sep: "\\" });
    expect(bakeBase(null, edit)).toEqual({ dir: "/v", stem: "a", sep: "/" });
    expect(bakeBase("/w/Film.cut-3.mp4", edit)!.stem).toBe("Film");
  });

  it("takes the first free versioned name", async () => {
    const taken = new Set(["/w/Film.cut.mp4", "/w/Film.cut-2.mp4"]);
    const path = await nextBakePath({ dir: "/w", stem: "Film", sep: "/" }, (p) => taken.has(p));
    expect(path).toBe("/w/Film.cut-3.mp4");
  });

  it("compares Windows paths regardless of case and separators", () => {
    expect(samePath("C:\\Work\\a.mp4", "c:/work/A.MP4")).toBe(true);
    expect(samePath("/w/a.mp4", "/w/A.mp4")).toBe(false);
  });
});
