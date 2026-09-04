import { describe, expect, it } from "vitest";
import { classifyDrop } from "./dropPaths";

describe("classifyDrop", () => {
  it("recognises a dropped video", () => {
    expect(classifyDrop(["D:\\footage\\scene.mp4"])).toEqual({
      kind: "video",
      path: "D:\\footage\\scene.mp4",
    });
  });

  it("recognises each supported container", () => {
    for (const ext of ["mp4", "m4v", "mov", "webm", "mkv"]) {
      expect(classifyDrop([`C:\\a\\clip.${ext}`]).kind).toBe("video");
    }
  });

  it("is case-insensitive about the extension", () => {
    expect(classifyDrop(["C:\\a\\CLIP.MP4"]).kind).toBe("video");
    expect(classifyDrop(["C:\\a\\SUBS.SRT"]).kind).toBe("srt");
  });

  it("recognises a dropped subtitle file", () => {
    expect(classifyDrop(["C:\\a\\subs.srt"])).toEqual({
      kind: "srt",
      path: "C:\\a\\subs.srt",
    });
  });

  it("prefers the video when both are dropped together", () => {
    const intent = classifyDrop(["C:\\a\\subs.srt", "C:\\a\\clip.mp4"]);
    expect(intent).toEqual({ kind: "video", path: "C:\\a\\clip.mp4" });
  });

  it("recognises a dropped project, and prefers it over everything", () => {
    expect(classifyDrop(["C:\\a\\job.sstproj"])).toEqual({
      kind: "project",
      path: "C:\\a\\job.sstproj",
    });
    expect(
      classifyDrop(["C:\\a\\clip.mp4", "C:\\a\\subs.srt", "C:\\a\\job.SSTPROJ"]).kind,
    ).toBe("project");
  });

  it("ignores unrelated files", () => {
    expect(classifyDrop(["C:\\a\\notes.txt", "C:\\a\\image.png"]).kind).toBe("none");
    expect(classifyDrop([]).kind).toBe("none");
  });

  it("does not match an extension appearing mid-path", () => {
    expect(classifyDrop(["C:\\mp4\\readme.txt"]).kind).toBe("none");
  });
});
