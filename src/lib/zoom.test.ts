import { describe, expect, it } from "vitest";
import { MAX_ZOOM, MIN_ZOOM, fitZoom, roundZoom, sliderToZoom, stepZoom, zoomToSlider } from "./zoom";

describe("zoom", () => {
  it("rounds to three significant figures at any scale", () => {
    expect(roundZoom(123.456)).toBe(123);
    expect(roundZoom(0.0123456)).toBeCloseTo(0.0123, 6);
    expect(roundZoom(1.23456)).toBeCloseTo(1.23, 6);
  });

  it("steps smoothly below one pixel per second, and back", () => {
    let z = 2;
    for (let i = 0; i < 20; i++) z = stepZoom(z, 1 / 1.15);
    expect(z).toBeLessThan(0.2);
    expect(z).toBeGreaterThan(MIN_ZOOM);
    for (let i = 0; i < 20; i++) z = stepZoom(z, 1.15);
    expect(z).toBeCloseTo(2, 1);
    expect(stepZoom(MIN_ZOOM, 0.5)).toBe(MIN_ZOOM);
    expect(stepZoom(MAX_ZOOM, 2)).toBe(MAX_ZOOM);
  });

  it("fits a whole track in the space there is", () => {
    // Two hours in 1000 px.
    const z = fitZoom(7200, 1000)!;
    expect(z * 7200).toBeLessThanOrEqual(1000);
    expect(z * 7200).toBeGreaterThan(990);
    expect(fitZoom(0, 1000)).toBeNull();
    expect(fitZoom(10, 0)).toBeNull();
    expect(fitZoom(0.1, 1000)).toBe(MAX_ZOOM);
  });

  it("maps a log-scale slider both ways", () => {
    expect(zoomToSlider(MIN_ZOOM)).toBe(0);
    expect(zoomToSlider(MAX_ZOOM)).toBe(1000);
    expect(sliderToZoom(zoomToSlider(50))).toBeCloseTo(50, -0.5);
    expect(sliderToZoom(0)).toBe(MIN_ZOOM);
  });
});
