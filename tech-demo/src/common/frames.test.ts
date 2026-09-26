import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core";
import { dirToUv, tangentBasis } from "./frames";

describe("dirToUv", () => {
  it("maps the prime meridian equator to the texture center-left", () => {
    const uv = dirToUv({ x: 1, y: 0, z: 0 });
    expect(uv.u).toBeCloseTo(0.5, 6);
    expect(uv.v).toBeCloseTo(0.5, 6);
  });

  it("maps poles to v extremes", () => {
    expect(dirToUv({ x: 0, y: 1, z: 0 }).v).toBeCloseTo(0, 6);
    expect(dirToUv({ x: 0, y: -1, z: 0 }).v).toBeCloseTo(1, 6);
  });

  it("stays in [0, 1]^2 for a sweep of directions", () => {
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      const uv = dirToUv({ x: Math.cos(a), y: 0.3, z: Math.sin(a) });
      expect(uv.u).toBeGreaterThanOrEqual(0);
      expect(uv.u).toBeLessThanOrEqual(1);
      expect(uv.v).toBeGreaterThanOrEqual(0);
      expect(uv.v).toBeLessThanOrEqual(1);
    }
  });
});

describe("tangentBasis", () => {
  it("returns orthonormal tangents, including near the poles", () => {
    for (const dir of [
      new Vector3(1, 0, 0),
      new Vector3(0, 1, 0),
      new Vector3(0, -1, 0),
      new Vector3(0.3, 0.9, 0.2).normalize(),
    ]) {
      const { t1, t2 } = tangentBasis(dir);
      expect(t1.dot(dir)).toBeCloseTo(0, 6);
      expect(t2.dot(dir)).toBeCloseTo(0, 6);
      expect(t1.dot(t2)).toBeCloseTo(0, 6);
      expect(t1.length()).toBeCloseTo(1, 6);
      expect(t2.length()).toBeCloseTo(1, 6);
    }
  });
});
