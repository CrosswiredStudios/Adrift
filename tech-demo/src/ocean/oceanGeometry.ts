/**
 * Ocean patch geometry + layout config. The patch is a camera-following
 * warped disc (dense near the camera) carrying the Gerstner geometry, surf
 * zone, and run-up; the shell (plain sphere at sea level) covers orbit views.
 * Extracted from ocean.ts (Phase 2 split).
 */
import { VertexData } from "@babylonjs/core";

export interface PatchConfig {
  /** Grid cells per side (vertices = (2*half+1)^2). */
  half: number;
  /** Patch radius on the surface, world units. */
  radius: number;
  /** Warp exponent: higher = denser center. */
  power: number;
  /** Radial bias over the shell: kills z-fighting at the rim. */
  bias: number;
  /** Camera altitude above which the patch hides (shell only). */
  maxAlt: number;
}

export const DEFAULT_PATCH: PatchConfig = {
  half: 48, // 97 x 97 vertices
  radius: 240,
  power: 1.55,
  bias: 0.12,
  maxAlt: 650,
};

/** Warped grid disc: dense at the centre, coarse at the rim (one draw call). */
export function buildPatchGeometry(cfg: PatchConfig = DEFAULT_PATCH): VertexData {
  const n = 2 * cfg.half + 1;
  const positions: number[] = [];
  const indices: number[] = [];
  const warp = (i: number): number => {
    const t = Math.abs(i) / cfg.half;
    return Math.sign(i) * Math.pow(t, cfg.power) * cfg.radius;
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      positions.push(warp(i - cfg.half), 0, warp(j - cfg.half));
    }
  }
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  return vd;
}
