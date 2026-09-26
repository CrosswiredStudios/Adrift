/** Shared scalar helpers. Single home for the clamp/smoothstep family so the
 * planet, ocean, flight, and vegetation modules cannot drift apart. */

/** Clamp `v` into [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Clamp `v` into [0, 1]. */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Smooth Hermite ramp between two edges (either order). */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Clamp into [-1, 1] (dot-product safety). */
export function clampUnit(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
