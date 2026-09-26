import { describe, expect, it } from "vitest";
import { mulberry32, parkMiller } from "./rng";

describe("mulberry32", () => {
  it("is deterministic for the same seed", () => {
    const a = mulberry32(1337);
    const b = mulberry32(1337);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
  });

  it("stays in [0, 1) and varies", () => {
    const rand = mulberry32(42);
    const vals = Array.from({ length: 100 }, () => rand());
    expect(vals.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(new Set(vals).size).toBeGreaterThan(90);
  });

  it("differs across seeds", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe("parkMiller", () => {
  it("matches the legacy ocean wave-table sequence", () => {
    // First values of the Park-Miller LCG with seed 1, normalized by 2^31-1.
    const rand = parkMiller(1);
    expect(rand()).toBeCloseTo(16807 / 2147483647, 9);
    expect(rand()).toBeCloseTo(282475249 / 2147483647, 9);
    expect(rand()).toBeCloseTo(1622650073 / 2147483647, 9);
  });

  it("is deterministic for the same seed", () => {
    const a = parkMiller(91);
    const b = parkMiller(91);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
  });
});
