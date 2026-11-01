import { describe, expect, it } from "vitest";
import { formatTick, tickStep } from "./ruler";

describe("ruler", () => {
  it("spaces ticks for a label at any zoom, down to hours", () => {
    expect(tickStep(100)).toBe(1);
    expect(tickStep(1)).toBe(120);
    // Fully zoomed out: two-hour ticks.
    expect(tickStep(0.01)).toBe(7200);
  });

  it("labels minutes, tenths and hours", () => {
    expect(formatTick(65, 5)).toBe("1:05");
    expect(formatTick(65.3, 0.1)).toBe("1:05.3");
    expect(formatTick(3600, 3600)).toBe("1:00:00");
    expect(formatTick(5400, 1800)).toBe("1:30:00");
    expect(formatTick(59.96, 0.1)).toBe("1:00.0");
  });
});
