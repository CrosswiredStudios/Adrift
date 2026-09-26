// Seeded value-noise + FBM helpers for procedural planet/ship detail.
// Deterministic: same seed always yields the same terrain.

export function hash3(x: number, y: number, z: number, seed: number): number {
  let h = seed + x * 374761393 + y * 668265263 + z * 2147483647;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return ((h >>> 0) % 100000) / 100000;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function trilinear(
  c000: number, c100: number, c010: number, c110: number,
  c001: number, c101: number, c011: number, c111: number,
  fx: number, fy: number, fz: number
): number {
  const x00 = c000 + (c100 - c000) * fx;
  const x10 = c010 + (c110 - c010) * fx;
  const x01 = c001 + (c101 - c001) * fx;
  const x11 = c011 + (c111 - c011) * fx;
  const y0 = x00 + (x10 - x00) * fy;
  const y1 = x01 + (x11 - x01) * fy;
  return y0 + (y1 - y0) * fz;
}

/** Value noise in [-1, 1]. */
export function noise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = smooth(x - xi), yf = smooth(y - yi), zf = smooth(z - zi);
  const v = trilinear(
    hash3(xi, yi, zi, seed), hash3(xi + 1, yi, zi, seed),
    hash3(xi, yi + 1, zi, seed), hash3(xi + 1, yi + 1, zi, seed),
    hash3(xi, yi, zi + 1, seed), hash3(xi + 1, yi, zi + 1, seed),
    hash3(xi, yi + 1, zi + 1, seed), hash3(xi + 1, yi + 1, zi + 1, seed),
    xf, yf, zf
  );
  return v * 2 - 1;
}

/** Fractal Brownian motion in roughly [-1, 1]. */
export function fbm3(x: number, y: number, z: number, octaves: number, seed: number): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(x * freq, y * freq, z * freq, seed + i * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}
