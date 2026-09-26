/**
 * Shared deterministic RNGs. One home for seeded sequences so terrain,
 * waves, speckle, and scatter stay reproducible from the same seed.
 *
 * Two generators are kept on purpose:
 * - `mulberry32`: fast general-purpose scatter (vegetation, speckle).
 * - `parkMiller`: the legacy wave-table generator (oceanWaves buildWaveSet).
 *   Kept byte-identical so existing wave layouts do not shift.
 */

/** Mulberry32: seed -> [0, 1). Good default for placement/speckle. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Park-Miller LCG: seed -> [0, 1). Legacy ocean wave-table sequence. */
export function parkMiller(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}
