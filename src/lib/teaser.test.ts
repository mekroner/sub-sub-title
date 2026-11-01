import { describe, expect, it } from "vitest";
import type { Cue } from "../types";
import { cuesForTeaser, teaserOutputPath, teaserScreenEdit } from "./teaser";
import { parseTemplate } from "./template";

const cue = (id: string, start: number, end: number): Cue => ({ id, start, end, text: id, speakerId: null });

describe("teaser", () => {
  it("keeps the cues before the cutoff and ends the one running over it", () => {
    const cues = [cue("a", 1, 2), cue("b", 9, 11), cue("c", 9.98, 10.5), cue("d", 12, 13)];
    expect(cuesForTeaser(cues, 10)).toEqual([cue("a", 1, 2), cue("b", 9, 10)]);
  });

  it("builds the screen as an edit of its own, images by staged name", () => {
    const canvas = { width: 1280, height: 720, fps: 25 };
    expect(teaserScreenEdit(canvas, null).items).toHaveLength(0);
    const template = parseTemplate(
      JSON.stringify({
        name: "Outro",
        canvas: { width: 1280, height: 720 },
        images: { "img-a1.png": { width: 10, height: 10, png: "AAAA" } },
        layers: [
          { lane: 0, image: "img-a1.png", item: { kind: "image", start: 0, duration: 3 } },
          { lane: 1, item: { kind: "text", start: 0.5, duration: 2, text: "Watch the full episode" } },
        ],
      }),
    );
    const screen = teaserScreenEdit(canvas, template);
    expect(screen.items.map((i) => [i.kind, i.start])).toEqual([
      ["image", 0],
      ["text", 0.5],
    ]);
    expect(screen.sources[0].path).toBe("img-a1.png");
  });

  it("names the teaser after the video", () => {
    expect(teaserOutputPath("/v/Film.cut.subtitled.mp4")).toBe("/v/Film.cut.teaser.mp4");
  });
});
