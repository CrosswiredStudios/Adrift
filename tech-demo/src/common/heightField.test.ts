import { describe, expect, it } from "vitest";
import { defaultShores, terrainHeightNormalized } from "./heightField";

describe("terrainHeightNormalized", () => {
  it("is deterministic for the same inputs", () => {
    const a = terrainHeightNormalized(0.3, 0.8, 0.5, 1337, -0.05, defaultShores);
    const b = terrainHeightNormalized(0.3, 0.8, 0.5, 1337, -0.05, defaultShores);
    expect(a).toBe(b);
  });

  it("stays in a sane band and varies across the globe", () => {
    const vals: number[] = [];
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      vals.push(terrainHeightNormalized(Math.cos(a), 0.2, Math.sin(a), 1337, -0.05, defaultShores));
    }
    expect(Math.max(...vals) - Math.min(...vals)).toBeGreaterThan(0.3);
    expect(vals.every((v) => v > -1.5 && v < 1.5)).toBe(true);
  });

  it("is continuous through the waterline (no cliff step)", () => {
    // Nudge the water level by epsilon at fixed sample points: the shaped
    // height must move smoothly (both branches meet at over == 0), not jump.
    // (Adjacent-sample steps measure real beach slope, not continuity.)
    let maxJump = 0;
    for (let i = 0; i < 200; i++) {
      const u = (i * 0.6180339887) % 1;
      const v = (i * 0.7548776662) % 1;
      const phi = u * Math.PI * 2;
      const cosT = 1 - 2 * v;
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const nx = sinT * Math.cos(phi);
      const ny = cosT;
      const nz = sinT * Math.sin(phi);
      const a = terrainHeightNormalized(nx, ny, nz, 1337, -0.05 - 1e-4, defaultShores);
      const b = terrainHeightNormalized(nx, ny, nz, 1337, -0.05 + 1e-4, defaultShores);
      maxJump = Math.max(maxJump, Math.abs(a - b));
    }
    expect(maxJump).toBeLessThan(1e-3);
  });

  it("produces both land and ocean for Vael defaults", () => {
    let land = 0;
    let ocean = 0;
    for (let i = 0; i < 200; i++) {
      const u = (i * 0.6180339887) % 1;
      const v = (i * 0.7548776662) % 1;
      const phi = u * Math.PI * 2;
      const cosT = 1 - 2 * v;
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const h = terrainHeightNormalized(
        sinT * Math.cos(phi),
        cosT,
        sinT * Math.sin(phi),
        1337,
        -0.05,
        defaultShores,
      );
      if (h > -0.05) land++;
      else ocean++;
    }
    expect(land).toBeGreaterThan(20);
    expect(ocean).toBeGreaterThan(20);
  });
});
