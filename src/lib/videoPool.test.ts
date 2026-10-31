import { describe, expect, it } from "vitest";
import { assignSlots } from "./videoPool";

describe("assignSlots", () => {
  it("keeps an item on its element across frames", () => {
    const first = assignSlots([], [{ itemId: "a", path: "/a.mp4" }]);
    expect(first).toEqual([
      { itemId: "a", path: "/a.mp4" },
      { itemId: null, path: null },
      { itemId: null, path: null },
    ]);
    const next = assignSlots(first, [
      { itemId: "a", path: "/a.mp4" },
      { itemId: "b", path: "/b.mp4" },
    ]);
    expect(next[0].itemId).toBe("a");
    expect(next[1]).toEqual({ itemId: "b", path: "/b.mp4" });
  });

  it("reuses a free element that already holds the file", () => {
    const pool = [
      { itemId: null, path: "/b.mp4" },
      { itemId: null, path: "/a.mp4" },
      { itemId: null, path: null },
    ];
    expect(assignSlots(pool, [{ itemId: "a2", path: "/a.mp4" }])[1].itemId).toBe("a2");
    // A fresh file prefers an empty element over evicting a loaded one.
    expect(assignSlots(pool, [{ itemId: "c", path: "/c.mp4" }])[2].itemId).toBe("c");
  });

  it("frees elements that are no longer wanted, keeping their file", () => {
    const pool = assignSlots([], [{ itemId: "a", path: "/a.mp4" }]);
    expect(assignSlots(pool, [])[0]).toEqual({ itemId: null, path: "/a.mp4" });
  });

  it("grows only when every element is busy", () => {
    const wanted = ["a", "b", "c", "d"].map((id) => ({ itemId: id, path: `/${id}.mp4` }));
    expect(assignSlots([], wanted)).toHaveLength(4);
  });
});
