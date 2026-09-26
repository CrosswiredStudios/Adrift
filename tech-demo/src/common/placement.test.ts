import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core";
import { fibDir, makeGradient, scatter } from "./placement";
import { mulberry32 } from "./rng";

describe("fibDir", () => {
  it("produces unit vectors spread over the sphere", () => {
    let sumY = 0;
    for (let i = 0; i < 100; i++) {
      const v = fibDir(new Vector3(), i, 100);
      expect(v.length()).toBeCloseTo(1, 6);
      sumY += v.y;
    }
    // Equal-area lattice: mean y near the equator.
    expect(Math.abs(sumY / 100)).toBeLessThan(0.05);
  });
});

describe("makeGradient", () => {
  it("returns ~0 on flat terrain and >0 on a slope", () => {
    const flat = makeGradient(() => 0.1);
    expect(flat(1, 0, 0)).toBeCloseTo(0, 6);
    const slope = makeGradient((x) => x);
    expect(slope(0, 1, 0)).toBeGreaterThan(0.5);
  });
});

describe("scatter", () => {
  const flatTerrain = () => 0.1;
  const flatGradient = () => 0;
  const limits = { line: 0.5, polar: 0.9, slope: 5, shore: 0.01 };

  it("is deterministic for the same seed", () => {
    const run = () =>
      scatter(20, 500, 60, 30, flatTerrain, flatGradient, -0.05, limits, () => 1, mulberry32(7));
    const a = run().map((p) => p.dir.asArray());
    const b = run().map((p) => p.dir.asArray());
    expect(a).toEqual(b);
  });

  it("respects water, line, polar, and slope gates", () => {
    const water = scatter(
      50,
      2000,
      100,
      50,
      () => -0.5,
      flatGradient,
      -0.05,
      limits,
      () => 1,
      mulberry32(1),
    );
    expect(water).toHaveLength(0);
    const high = scatter(
      50,
      2000,
      100,
      50,
      () => 0.9,
      flatGradient,
      -0.05,
      limits,
      () => 1,
      mulberry32(1),
    );
    expect(high).toHaveLength(0);
    const steep = scatter(
      50,
      2000,
      100,
      50,
      flatTerrain,
      () => 99,
      -0.05,
      limits,
      () => 1,
      mulberry32(1),
    );
    expect(steep).toHaveLength(0);
  });

  it("dedupes to one instance per lat-long cell", () => {
    const placed = scatter(
      500,
      2000,
      40,
      20,
      flatTerrain,
      flatGradient,
      -0.05,
      limits,
      () => 1,
      mulberry32(3),
    );
    expect(placed.length).toBeLessThanOrEqual(40 * 20);
    expect(placed.length).toBeGreaterThan(100);
  });
});
