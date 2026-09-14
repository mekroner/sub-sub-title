import { describe, expect, it } from "vitest";
import type { Section } from "../types";
import {
  insertSection,
  moveSection,
  newSection,
  nextSection,
  previousSection,
  removeSection,
  renameSection,
  sectionAt,
  sectionSpans,
  setSectionNote,
  sortSections,
} from "./sections";

const at = (start: number, label = `s${start}`): Section => ({
  id: `id-${start}`,
  start,
  label,
});

const list = [at(0), at(10), at(25)];

describe("sortSections", () => {
  it("orders by start", () => {
    expect(sortSections([at(25), at(0), at(10)]).map((s) => s.start)).toEqual([0, 10, 25]);
  });
});

describe("newSection", () => {
  it("names by the count, so the name does not depend on where it lands", () => {
    expect(newSection(list, 15).label).toBe("Section 4");
    expect(newSection(list, 15).id).toBeTruthy();
  });
});

describe("insertSection", () => {
  it("inserts in time order", () => {
    expect(insertSection(list, at(15), 60).map((s) => s.start)).toEqual([0, 10, 15, 25]);
  });

  it("clamps outside the video", () => {
    expect(insertSection([], at(-5), 60)[0].start).toBe(0);
    expect(insertSection([], at(900), 60)[0].start).toBe(60);
  });
});

describe("renameSection", () => {
  it("renames", () => {
    expect(renameSection(list, "id-10", "Cut").find((s) => s.id === "id-10")?.label).toBe("Cut");
  });

  it("returns the same array when nothing changed", () => {
    expect(renameSection(list, "id-10", "s10")).toBe(list);
    expect(renameSection(list, "missing", "Cut")).toBe(list);
  });
});

describe("setSectionNote", () => {
  it("sets a note, and removes it again when cleared", () => {
    const noted = setSectionNote(list, "id-10", "She knows");
    expect(noted.find((s) => s.id === "id-10")?.note).toBe("She knows");
    expect("note" in setSectionNote(noted, "id-10", "  ")[1]).toBe(false);
  });

  it("returns the same array when nothing changed", () => {
    expect(setSectionNote(list, "id-10", "")).toBe(list);
    expect(setSectionNote(list, "missing", "x")).toBe(list);
  });
});

describe("moveSection", () => {
  it("moves and re-sorts", () => {
    expect(moveSection(list, "id-0", 30, 60).map((s) => s.id)).toEqual([
      "id-10",
      "id-25",
      "id-0",
    ]);
  });

  it("clamps to the video", () => {
    expect(moveSection(list, "id-10", -3, 60).find((s) => s.id === "id-10")?.start).toBe(0);
    expect(moveSection(list, "id-10", 99, 60).find((s) => s.id === "id-10")?.start).toBe(60);
  });

  it("returns the same array when nothing changed", () => {
    expect(moveSection(list, "id-10", 10, 60)).toBe(list);
    expect(moveSection(list, "missing", 5, 60)).toBe(list);
  });
});

describe("removeSection", () => {
  it("removes", () => {
    expect(removeSection(list, "id-10").map((s) => s.id)).toEqual(["id-0", "id-25"]);
  });

  it("returns the same array when there was nothing to remove", () => {
    expect(removeSection(list, "missing")).toBe(list);
  });
});

describe("sectionSpans", () => {
  it("runs each section to the next, and the last to the end", () => {
    expect(sectionSpans(list, 60).map((s) => [s.start, s.end])).toEqual([
      [0, 10],
      [10, 25],
      [25, 60],
    ]);
  });

  it("sorts defensively, so an unsorted list still spans forwards", () => {
    const spans = sectionSpans([at(25), at(0)], 60);
    expect(spans.map((s) => [s.start, s.end])).toEqual([
      [0, 25],
      [25, 60],
    ]);
  });

  it("is empty for no sections", () => {
    expect(sectionSpans([], 60)).toEqual([]);
  });
});

describe("sectionAt", () => {
  it("finds the section covering an instant", () => {
    expect(sectionAt(list, 12)?.id).toBe("id-10");
    expect(sectionAt(list, 25)?.id).toBe("id-25");
    expect(sectionAt(list, 999)?.id).toBe("id-25");
  });

  it("is null before the first section", () => {
    expect(sectionAt([at(5)], 1)).toBeNull();
    expect(sectionAt([], 1)).toBeNull();
  });
});

describe("nextSection / previousSection", () => {
  it("steps forwards", () => {
    expect(nextSection(list, 0)?.id).toBe("id-10");
    expect(nextSection(list, 10)?.id).toBe("id-25");
    expect(nextSection(list, 25)).toBeNull();
  });

  it("steps backwards", () => {
    expect(previousSection(list, 25)?.id).toBe("id-10");
    expect(previousSection(list, 10)?.id).toBe("id-0");
    expect(previousSection(list, 0)).toBeNull();
  });

  it("walks past the flag the playhead is sitting exactly on", () => {
    // Landing on a flag and pressing again must keep moving, not stick.
    const first = previousSection(list, 25);
    expect(first?.id).toBe("id-10");
    expect(previousSection(list, first!.start)?.id).toBe("id-0");
  });
});
