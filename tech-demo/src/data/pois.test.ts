import { describe, expect, it } from "vitest";
import { POIS, poiDirection, latLonToDir, tangentAxes, headingVector } from "./pois";
import { VESPER_DRIFT } from "./system";
import { terrainHeight, hasOcean } from "../terrain/heightField";

describe("points of interest", () => {
  it("every POI resolves to a unit direction on a known body", () => {
    for (const poi of POIS) {
      const def = VESPER_DRIFT.find((d) => d.id === poi.body);
      expect(def).toBeDefined();
      const d = poiDirection(poi, def!.radius);
      expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 9);
    }
  });

  it("every POI stands on dry land (at least 1 m above the sea)", () => {
    for (const poi of POIS) {
      const def = VESPER_DRIFT.find((d) => d.id === poi.body)!;
      const shape = def.terrain!;
      const d = poiDirection(poi, def.radius);
      const h = terrainHeight(shape, d[0], d[1], d[2]);
      if (hasOcean(shape)) expect(h - shape.waterLevel * shape.relief).toBeGreaterThan(1);
    }
  });

  it("relative placement lands at the requested distance", () => {
    const pod = POIS.find((p) => p.id === "pad")!;
    const a = poiDirection(
      POIS.find((p) => p.id === "start")!,
      2000,
    );
    const b = poiDirection(pod, 2000);
    const dist = Math.acos(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * 2000;
    expect(dist).toBeCloseTo(Math.hypot(pod.near!.east, pod.near!.north), 0);
  });

  it("east points along the spin (increasing longitude) and north toward +Y", () => {
    const d = latLonToDir(0, 0);
    const { east, north } = tangentAxes(d);
    const d2 = latLonToDir(0, 1);
    const move = [d2[0] - d[0], d2[1] - d[1], d2[2] - d[2]];
    expect(move[0] * east[0] + move[1] * east[1] + move[2] * east[2]).toBeGreaterThan(0);
    expect(north[1]).toBeCloseTo(1, 9);
    const h = headingVector(d, 90);
    expect(h[0] * east[0] + h[1] * east[1] + h[2] * east[2]).toBeCloseTo(1, 9);
  });
});
