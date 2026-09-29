/**
 * Portable gradient noise.
 *
 * Integer-only hashing (Math.imul + shifts on uint32) and 3D Perlin gradient
 * noise with quintic fade. Every operation has an exact equivalent in
 * GLSL ES 3.0 / WGSL (`uint` arithmetic wraps the same way), so the GPU can
 * evaluate the same terrain function as the CPU. `NOISE_GLSL` below is that
 * port; tests/noise.spec.ts renders it and compares against this file.
 *
 * No Babylon imports: this module runs inside the terrain Web Workers.
 */

/** 32-bit integer hash (lowbias32 by Chris Wellons). */
export function hash32(x: number): number {
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/** Hash of an integer lattice point + seed. */
export function hash3i(ix: number, iy: number, iz: number, seed: number): number {
  let h = hash32((ix | 0) ^ hash32(seed | 0));
  h = hash32((iy | 0) ^ h);
  h = hash32((iz | 0) ^ h);
  return h;
}

/** Uniform float in [0, 1) from a lattice point. */
export function hashFloat3(ix: number, iy: number, iz: number, seed: number): number {
  return (hash3i(ix, iy, iz, seed) >>> 8) / 16777216;
}

// 12 edge-midpoint gradients (+4 repeats to make 16) — Perlin's improved set.
const GX = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0, 1, 0, -1, 0];
const GY = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1];
const GZ = [0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1, 0, 1, 0, -1];

function grad(ix: number, iy: number, iz: number, seed: number, x: number, y: number, z: number): number {
  const h = hash3i(ix, iy, iz, seed) & 15;
  return GX[h] * x + GY[h] * y + GZ[h] * z;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 3D gradient noise, roughly in [-1, 1] (scaled so typical |n| <= ~0.9). */
export function perlin3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const u = fade(fx);
  const v = fade(fy);
  const w = fade(fz);
  const n000 = grad(ix, iy, iz, seed, fx, fy, fz);
  const n100 = grad(ix + 1, iy, iz, seed, fx - 1, fy, fz);
  const n010 = grad(ix, iy + 1, iz, seed, fx, fy - 1, fz);
  const n110 = grad(ix + 1, iy + 1, iz, seed, fx - 1, fy - 1, fz);
  const n001 = grad(ix, iy, iz + 1, seed, fx, fy, fz - 1);
  const n101 = grad(ix + 1, iy, iz + 1, seed, fx - 1, fy, fz - 1);
  const n011 = grad(ix, iy + 1, iz + 1, seed, fx, fy - 1, fz - 1);
  const n111 = grad(ix + 1, iy + 1, iz + 1, seed, fx - 1, fy - 1, fz - 1);
  const x00 = n000 + u * (n100 - n000);
  const x10 = n010 + u * (n110 - n010);
  const x01 = n001 + u * (n101 - n001);
  const x11 = n011 + u * (n111 - n011);
  const y0 = x00 + v * (x10 - x00);
  const y1 = x01 + v * (x11 - x01);
  return y0 + w * (y1 - y0);
}

/**
 * Fractal sum of `octaves` noise layers (lacunarity ~2, gain 0.5),
 * normalized by the amplitude sum so the range stays ~[-1, 1].
 * Each octave gets its own seed so lattice artifacts don't line up.
 */
export function fbm(x: number, y: number, z: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * perlin3(x * f, y * f, z * f, seed + i * 1013);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

/** Ridged multifractal in [0, 1]: sharp crests where the noise crosses zero. */
export function ridged(x: number, y: number, z: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  let prev = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(perlin3(x * f, y * f, z * f, seed + i * 1013));
    n *= n;
    sum += amp * n * prev;
    prev = n;
    norm += amp;
    amp *= 0.5;
    f *= 2.07;
  }
  return sum / norm;
}

/**
 * GLSL ES 3.0 port of hash32 / hash3i / perlin3 / fbm. Bit-exact hashing
 * (uint wraps like Math.imul + >>> 0); float math differs only in rounding.
 */
export const NOISE_GLSL = `
uint nzHash32(uint x) {
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
uint nzHash3i(ivec3 p, int seed) {
  uint h = nzHash32(uint(p.x) ^ nzHash32(uint(seed)));
  h = nzHash32(uint(p.y) ^ h);
  h = nzHash32(uint(p.z) ^ h);
  return h;
}
float nzGrad(ivec3 i, int seed, vec3 f) {
  uint h = nzHash3i(i, seed) & 15u;
  // Same 16-entry table as the CPU version.
  const float GX[16] = float[16](1.,-1.,1.,-1.,1.,-1.,1.,-1.,0.,0.,0.,0.,1.,0.,-1.,0.);
  const float GY[16] = float[16](1.,1.,-1.,-1.,0.,0.,0.,0.,1.,-1.,1.,-1.,1.,-1.,1.,-1.);
  const float GZ[16] = float[16](0.,0.,0.,0.,1.,1.,-1.,-1.,1.,1.,-1.,-1.,0.,1.,0.,-1.);
  return GX[h] * f.x + GY[h] * f.y + GZ[h] * f.z;
}
float nzFade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float nzPerlin3(vec3 p, int seed) {
  vec3 fl = floor(p);
  ivec3 i = ivec3(fl);
  vec3 f = p - fl;
  vec3 u = vec3(nzFade(f.x), nzFade(f.y), nzFade(f.z));
  float n000 = nzGrad(i, seed, f);
  float n100 = nzGrad(i + ivec3(1,0,0), seed, f - vec3(1,0,0));
  float n010 = nzGrad(i + ivec3(0,1,0), seed, f - vec3(0,1,0));
  float n110 = nzGrad(i + ivec3(1,1,0), seed, f - vec3(1,1,0));
  float n001 = nzGrad(i + ivec3(0,0,1), seed, f - vec3(0,0,1));
  float n101 = nzGrad(i + ivec3(1,0,1), seed, f - vec3(1,0,1));
  float n011 = nzGrad(i + ivec3(0,1,1), seed, f - vec3(0,1,1));
  float n111 = nzGrad(i + ivec3(1,1,1), seed, f - vec3(1,1,1));
  float x00 = mix(n000, n100, u.x);
  float x10 = mix(n010, n110, u.x);
  float x01 = mix(n001, n101, u.x);
  float x11 = mix(n011, n111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}
float nzFbm(vec3 p, int octaves, int seed) {
  float sum = 0.0, amp = 1.0, norm = 0.0, f = 1.0;
  for (int i = 0; i < 12; i++) {
    if (i >= octaves) break;
    sum += amp * nzPerlin3(p * f, seed + i * 1013);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}`;
