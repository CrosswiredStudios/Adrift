import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core";
import { defaultShores } from "../common/heightField";
import {
  Body,
  atmosphereFactor,
  bodyAltitude,
  isOverWater,
  surfaceAltitude,
  surfaceRadius,
  terrainHeightAt,
} from "./planets";

/**
 * The free height helpers only read seed/waterLevel/shore/radius/relief, so a
 * structural stub (no Scene, no meshes) is enough to pin their contracts:
 * water/land agreement, surface = max(terrain, sea level), altitude splits.
 */
function makeStubBody(): Body {
  return {
    name: "stub",
    mesh: undefined as never,
    radius: 600,
    atmosphereHeight: 520,
    atmosphereColor: undefined as never,
    skyColor: undefined as never,
    mu: 0,
    seed: 1337,
    relief: 0.045,
    waterLevel: -0.05,
    shore: defaultShores,
    center: new Vector3(0, 0, 0),
    atmosphereAt: () => 0,
    surfaceAltitudeAt: () => 0,
    surfaceRadiusAt: () => 600,
    isOverWaterAt: () => false,
    waterSurfaceRadiusAt: () => 600,
  };
}

const D = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z).normalize();

describe("terrainHeightAt / isOverWater", () => {
  it("agrees on water vs land across the globe", () => {
    const body = makeStubBody();
    for (let i = 0; i < 200; i++) {
      const u = (i * 0.6180339887) % 1;
      const v = (i * 0.7548776662) % 1;
      const phi = u * Math.PI * 2;
      const cosT = 1 - 2 * v;
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const d = D(sinT * Math.cos(phi), cosT, sinT * Math.sin(phi));
      expect(isOverWater(body, d)).toBe(terrainHeightAt(body, d) < body.waterLevel);
    }
  });

  it("finds both land and water", () => {
    const body = makeStubBody();
    let land = 0;
    let water = 0;
    for (let i = 0; i < 500; i++) {
      const u = (i * 0.6180339887) % 1;
      const v = (i * 0.7548776662) % 1;
      const phi = u * Math.PI * 2;
      const cosT = 1 - 2 * v;
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      if (isOverWater(body, D(sinT * Math.cos(phi), cosT, sinT * Math.sin(phi)))) water++;
      else land++;
    }
    expect(land).toBeGreaterThan(0);
    expect(water).toBeGreaterThan(0);
  });
});

describe("surfaceRadius", () => {
  it("equals sea level over water and terrain over land", () => {
    const body = makeStubBody();
    const sea = body.radius * (1 + body.waterLevel * body.relief);
    for (let i = 0; i < 200; i++) {
      const u = (i * 0.6180339887) % 1;
      const v = (i * 0.7548776662) % 1;
      const phi = u * Math.PI * 2;
      const cosT = 1 - 2 * v;
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const d = D(sinT * Math.cos(phi), cosT, sinT * Math.sin(phi));
      const r = surfaceRadius(body, d);
      if (isOverWater(body, d)) {
        expect(r).toBeCloseTo(sea, 6);
      } else {
        expect(r).toBeGreaterThan(sea);
      }
    }
  });
});

describe("bodyAltitude / surfaceAltitude", () => {
  it("splits mean-radius altitude from above-surface altitude", () => {
    const body = makeStubBody();
    // Find a land direction with real relief.
    let land: Vector3 = D(0, 1, 0);
    for (let i = 0; i < 500; i++) {
      const u = (i * 0.6180339887) % 1;
      const v = (i * 0.7548776662) % 1;
      const phi = u * Math.PI * 2;
      const cosT = 1 - 2 * v;
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const d = D(sinT * Math.cos(phi), cosT, sinT * Math.sin(phi));
      if (!isOverWater(body, d) && terrainHeightAt(body, d) > 0.3) {
        land = d;
        break;
      }
    }
    const point = land.scale(body.radius + 100);
    expect(bodyAltitude(body, point)).toBeCloseTo(100, 6);
    // Over raised terrain the surface is closer than the mean radius.
    expect(surfaceAltitude(body, point)).toBeLessThan(100);
    expect(surfaceAltitude(body, point)).toBeGreaterThan(0);
    // On the surface itself the altitude is ~0.
    const onSurface = land.scale(surfaceRadius(body, land));
    expect(surfaceAltitude(body, onSurface)).toBeCloseTo(0, 3);
  });
});

describe("atmosphereFactor", () => {
  it("is 1 at/below the surface and 0 above the shell", () => {
    const body = makeStubBody();
    const d = D(0, 1, 0);
    expect(atmosphereFactor(body, d.scale(body.radius - 10))).toBe(1);
    expect(atmosphereFactor(body, d.scale(body.radius + body.atmosphereHeight + 10))).toBe(0);
    const mid = atmosphereFactor(body, d.scale(body.radius + body.atmosphereHeight / 2));
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
  });
});
