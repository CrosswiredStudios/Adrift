import { describe, expect, it } from "vitest";
import { clamp, clamp01, clampUnit, smoothstep } from "./math";

describe("clamp", () => {
  it("clamps below, inside, and above the range", () => {
    expect(clamp(-2, 0, 1)).toBe(0);
    expect(clamp(0.4, 0, 1)).toBe(0.4);
    expect(clamp(5, 0, 1)).toBe(1);
  });
});

describe("clamp01", () => {
  it("clamps into [0, 1]", () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1.5)).toBe(1);
  });
});

describe("clampUnit", () => {
  it("clamps into [-1, 1] for dot-product safety", () => {
    expect(clampUnit(-2)).toBe(-1);
    expect(clampUnit(0.3)).toBe(0.3);
    expect(clampUnit(2)).toBe(1);
  });
});

describe("smoothstep", () => {
  it("ramps 0 -> 1 across the edge window", () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 0)).toBe(0);
    expect(smoothstep(0, 1, 1)).toBe(1);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 6);
  });

  it("supports reversed edges (used for fade-outs)", () => {
    expect(smoothstep(1, 0, 0)).toBe(1);
    expect(smoothstep(1, 0, 1)).toBe(0);
    expect(smoothstep(0.4, 0.0, 0.2)).toBeCloseTo(0.5, 6);
  });
});
