import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core";
import { MAX_WAVES, buildWaveSet, cpuSwashRise, cpuWaveHeightAt, cpuWaveNormalAt } from "./oceanWaves";

const P = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);

describe("buildWaveSet", () => {
  it("is deterministic for the same seed", () => {
    const a = buildWaveSet({ seaState: "mild" }, 7);
    const b = buildWaveSet({ seaState: "mild" }, 7);
    expect(a.count).toBe(b.count);
    expect(Array.from(a.axes)).toEqual(Array.from(b.axes));
    expect(Array.from(a.params)).toEqual(Array.from(b.params));
    expect(Array.from(a.phases)).toEqual(Array.from(b.phases));
  });

  it("varies with seed and sea state", () => {
    const a = buildWaveSet({ seaState: "mild" }, 7);
    const b = buildWaveSet({ seaState: "mild" }, 8);
    expect(Array.from(a.phases)).not.toEqual(Array.from(b.phases));
    const rough = buildWaveSet({ seaState: "rough" }, 7);
    const calm = buildWaveSet({ seaState: "calm" }, 7);
    const amp = (s: { params: Float32Array; count: number }): number => {
      let total = 0;
      for (let i = 0; i < s.count; i++) total += s.params[i * 4 + 1];
      return total;
    };
    expect(amp(rough)).toBeGreaterThan(amp(calm));
  });

  it("packs axes as unit vectors and leaves unused slots at zero amplitude", () => {
    const set = buildWaveSet({ seaState: "mild" }, 7);
    expect(set.count).toBeLessThanOrEqual(MAX_WAVES);
    for (let i = 0; i < set.count; i++) {
      const len = Math.hypot(set.axes[i * 4], set.axes[i * 4 + 1], set.axes[i * 4 + 2]);
      expect(len).toBeCloseTo(1, 5);
      expect(set.params[i * 4 + 1]).toBeGreaterThan(0); // amplitude
      expect(set.params[i * 4 + 0]).toBeGreaterThan(0); // wavelength
      expect(set.params[i * 4 + 2]).toBeGreaterThan(0); // phase speed
    }
    for (let i = set.count; i < MAX_WAVES; i++) {
      expect(set.params[i * 4 + 1]).toBe(0);
    }
  });

  it("keeps Gerstner steepness bounded so the surface cannot fold", () => {
    for (const seaState of ["calm", "mild", "rough"] as const) {
      const set = buildWaveSet({ seaState }, 42);
      for (const w of set.components) {
        const k = (2 * Math.PI) / w.wavelength;
        expect(w.horiz * k * w.amplitude).toBeLessThan(1);
      }
    }
  });
});

describe("cpuWaveHeightAt", () => {
  it("is zero at time zero on the axis plane and bounded everywhere", () => {
    const set = buildWaveSet({ seaState: "rough" }, 7);
    let maxAbs = 0;
    for (let i = 0; i < 200; i++) {
      const u = (i * 0.6180339887) % 1;
      const v = (i * 0.7548776662) % 1;
      const phi = u * Math.PI * 2;
      const cosT = 1 - 2 * v;
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const p = P(sinT * Math.cos(phi), cosT, sinT * Math.sin(phi)).scale(600);
      const h = cpuWaveHeightAt(set, p, 3.7);
      maxAbs = Math.max(maxAbs, Math.abs(h));
    }
    // Rough sea amplitudes must stay in the single-digit range (ship floats at ~1.2).
    expect(maxAbs).toBeGreaterThan(0.1);
    expect(maxAbs).toBeLessThan(12);
  });

  it("varies with time (waves move)", () => {
    const set = buildWaveSet({ seaState: "mild" }, 7);
    const p = P(600, 0, 0);
    const a = cpuWaveHeightAt(set, p, 0);
    const b = cpuWaveHeightAt(set, p, 5);
    expect(Math.abs(a - b)).toBeGreaterThan(1e-3);
  });
});

describe("cpuSwashRise", () => {
  it("grows with shallowness (run-up amplifies near the beach)", () => {
    const set = buildWaveSet({ seaState: "mild" }, 7);
    const p = P(600, 0, 0);
    const deep = Math.abs(cpuSwashRise(set.swash, p, 1.3, 0));
    let shallowMax = 0;
    for (let t = 0; t < 20; t++) {
      shallowMax = Math.max(shallowMax, Math.abs(cpuSwashRise(set.swash, p, t * 0.7, 1)));
    }
    expect(shallowMax).toBeGreaterThan(deep);
  });
});

describe("cpuWaveNormalAt", () => {
  it("returns a unit vector near the radial on calm seas", () => {
    const set = buildWaveSet({ seaState: "calm" }, 7);
    const center = P(0, 0, 0);
    const dir = P(0, 1, 0);
    const out = P(0, 0, 0);
    cpuWaveNormalAt(set, center, dir, 600, 2.5, out);
    expect(out.length()).toBeCloseTo(1, 5);
    expect(Vector3.Dot(out, dir)).toBeGreaterThan(0.95);
  });
});
