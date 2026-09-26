/**
 * Shared spherical-frame helpers. The lat-long UV mapping (dir -> [0,1]^2)
 * and the stable tangent-basis construction are used by the ocean shader,
 * the baked height field, the wet-sand plugin, and vegetation placement.
 * One copy so the CPU and GPU mappings cannot drift.
 */
import { Vector3 } from "@babylonjs/core";

/** 1/(2π) and 1/π for the lat-long mapping. */
export const INV_TAU = 0.15915494;
export const INV_PI = 0.31830989;

/** Direction -> lat-long UV in [0,1]^2. `d` must be unit length. */
export function dirToUv(d: { x: number; y: number; z: number }): { u: number; v: number } {
  return {
    u: Math.atan2(d.z, d.x) * INV_TAU + 0.5,
    v: Math.acos(Math.min(1, Math.max(-1, d.y))) * INV_PI,
  };
}

/** GLSL twin of dirToUv for embedded shaders. Input `d` must be normalized. */
export const DIR_TO_UV_GLSL = `
vec2 dirToUv(vec3 d) {
  return vec2(atan(d.z, d.x) * ${INV_TAU.toFixed(8)} + 0.5,
              acos(clamp(d.y, -1.0, 1.0)) * ${INV_PI.toFixed(8)});
}`;

/**
 * Stable tangent basis around a unit direction. Picks a reference axis far
 * from `dir` so the cross product never degenerates at the poles.
 */
export function tangentBasis(dir: Vector3): { t1: Vector3; t2: Vector3 } {
  const ref = Math.abs(dir.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  const t1 = Vector3.Cross(dir, ref).normalize();
  const t2 = Vector3.Cross(dir, t1).normalize();
  return { t1, t2 };
}
