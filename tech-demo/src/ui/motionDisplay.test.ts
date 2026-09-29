import { describe, expect, it } from "vitest";
import { MOTION_FULL_SCALE, axisReadout, motionScale } from "./motionDisplay";

describe("motion display", () => {
  it("log scale keeps slow drifts visible and saturates at full scale", () => {
    expect(motionScale(0)).toBe(0);
    expect(motionScale(1)).toBeGreaterThan(0.1);
    expect(motionScale(-1)).toBeCloseTo(-motionScale(1));
    expect(motionScale(10)).toBeGreaterThan(motionScale(1));
    expect(motionScale(MOTION_FULL_SCALE)).toBeCloseTo(1);
    expect(motionScale(10 * MOTION_FULL_SCALE)).toBe(1);
  });

  it("readouts name the direction of travel", () => {
    expect(axisReadout(12.34, "F", "B")).toBe("F   12.3");
    expect(axisReadout(-3, "R", "L")).toBe("L    3.0");
    expect(axisReadout(0.01, "U", "D")).toBe("     0.0");
    expect(axisReadout(250.4, "F", "B")).toBe("F    250");
  });
});
