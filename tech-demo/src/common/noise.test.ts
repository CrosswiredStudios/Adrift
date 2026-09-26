import { describe, expect, it } from "vitest";
import { fbm3, hash3, noise3 } from "./noise";

describe("hash3", () => {
  it("is deterministic and bounded in [0, 1)", () => {
    expect(hash3(1, 2, 3, 99)).toBe(hash3(1, 2, 3, 99));
    expect(hash3(1, 2, 3, 99)).not.toBe(hash3(1, 2, 4, 99));
    for (let i = 0; i < 50; i++) {
      const v = hash3(i, i * 2, i * 3, 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("noise3", () => {
  it("stays in [-1, 1] and is continuous at lattice points", () => {
    for (let i = 0; i < 20; i++) {
      const v = noise3(i * 0.37, i * 0.73, i * 0.11, 5);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
    // At integer lattice the smootherstep weights are 0, so value = corner hash.
    expect(noise3(2, 3, 4, 5)).toBeCloseTo(hash3(2, 3, 4, 5) * 2 - 1, 9);
  });
});

describe("fbm3", () => {
  it("is deterministic and roughly centered", () => {
    expect(fbm3(0.5, 0.25, 0.75, 4, 11)).toBe(fbm3(0.5, 0.25, 0.75, 4, 11));
    let sum = 0;
    for (let i = 0; i < 100; i++) sum += fbm3(i * 0.31, i * 0.17, 0.5, 4, 11);
    expect(Math.abs(sum / 100)).toBeLessThan(0.35);
  });
});
