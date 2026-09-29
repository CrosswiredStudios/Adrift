/**
 * Cloud density field shared by the GPU raymarch and the CPU.
 *
 * The field lives in the body-fixed frame on a spherical shell
 * [base, base + thickness] above the mean radius, so clouds wrap the planet
 * with no planar projection (no mirroring, no streaks). Coverage and detail
 * come from a tiling 32^3 noise volume; the CPU samples the *same bytes*
 * with the same trilinear filtering and the same formula, so the in-cloud
 * whiteout veil matches what is drawn.
 *
 * Clouds drift by slowly rotating the sampling position about the spin axis
 * (a steady wind relative to the ground).
 */
export interface CloudParams {
  /** Planet mean radius (m). */
  radius: number;
  /** Deck base above the mean radius (m). */
  base: number;
  /** Deck thickness (m). */
  thickness: number;
  /** 0..1 sky coverage. */
  coverage: number;
  /** Extinction per meter at density 1. */
  extinction: number;
  /** Wind: drift rate about the spin axis (rad/s). */
  windRate: number;
}

/** Feature sizes (m) of the coverage, secondary and erosion noise. */
export const CLOUD_SCALES = { coverage: 1100, secondary: 420, erosion: 90 } as const;
const OFF2: [number, number, number] = [0.37, 0.11, 0.73];
const OFF3: [number, number, number] = [0.61, 0.29, 0.17];

export class CloudVolumeData {
  constructor(
    readonly data: Uint8Array,
    readonly size = 32,
  ) {}

  /**
   * Trilinear sample with repeat wrapping at normalized coords (u, v, w),
   * matching GL LINEAR + REPEAT on a size^3 R8 texture: texel centres at
   * (i + 0.5) / size.
   */
  sample(u: number, v: number, w: number): number {
    const n = this.size;
    const x = u * n - 0.5;
    const y = v * n - 0.5;
    const z = w * n - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const z0 = Math.floor(z);
    const fx = x - x0;
    const fy = y - y0;
    const fz = z - z0;
    const wrap = (i: number): number => ((i % n) + n) % n;
    const X0 = wrap(x0);
    const X1 = wrap(x0 + 1);
    const Y0 = wrap(y0);
    const Y1 = wrap(y0 + 1);
    const Z0 = wrap(z0);
    const Z1 = wrap(z0 + 1);
    const d = this.data;
    const at = (xi: number, yi: number, zi: number): number => d[(zi * n + yi) * n + xi] / 255;
    const c00 = at(X0, Y0, Z0) + (at(X1, Y0, Z0) - at(X0, Y0, Z0)) * fx;
    const c10 = at(X0, Y1, Z0) + (at(X1, Y1, Z0) - at(X0, Y1, Z0)) * fx;
    const c01 = at(X0, Y0, Z1) + (at(X1, Y0, Z1) - at(X0, Y0, Z1)) * fx;
    const c11 = at(X0, Y1, Z1) + (at(X1, Y1, Z1) - at(X0, Y1, Z1)) * fx;
    const c0 = c00 + (c10 - c00) * fy;
    const c1 = c01 + (c11 - c01) * fy;
    return c0 + (c1 - c0) * fz;
  }
}

function sat(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = sat((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** 0..1 cloud density at a body-frame point (CPU twin of cloudDensity in CLOUD_GLSL). */
export function cloudDensityAt(
  vol: CloudVolumeData,
  p: CloudParams,
  x: number,
  y: number,
  z: number,
  time: number,
): number {
  const r = Math.hypot(x, y, z);
  const h = (r - (p.radius + p.base)) / p.thickness;
  if (h <= 0 || h >= 1) return 0;
  // Wind: rotate the sample point about +Y by -windRate * t.
  const a = -p.windRate * time;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // Babylon/GLSL convention for a rotation about Y: x' = c x + s z, z' = -s x + c z.
  const qx = c * x + s * z;
  const qz = -s * x + c * z;
  const qy = y;
  const S = CLOUD_SCALES;
  const cov =
    0.65 * vol.sample(qx / S.coverage, qy / S.coverage, qz / S.coverage) +
    0.35 * vol.sample(qx / S.secondary + OFF2[0], qy / S.secondary + OFF2[1], qz / S.secondary + OFF2[2]);
  const shape = sat((cov - (1 - p.coverage)) / 0.22) * smooth(0, 0.18, h) * smooth(1, 0.55, h);
  if (shape <= 0) return 0;
  const erode = vol.sample(qx / S.erosion + OFF3[0], qy / S.erosion + OFF3[1], qz / S.erosion + OFF3[2]);
  return sat(shape - (1 - shape) * erode * 0.7);
}

/** GLSL twin of cloudDensityAt (needs `uniform sampler3D uCloudVol` and CloudParams uniforms). */
export const CLOUD_DENSITY_GLSL = `
float cloudDensity(vec3 p) {
  float r = length(p);
  float h = (r - (uPlanetRadius + uCloudBase)) / uCloudThickness;
  if (h <= 0.0 || h >= 1.0) return 0.0;
  float a = -uWindRate * uTime;
  float c = cos(a);
  float s = sin(a);
  vec3 q = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
  float cov = 0.65 * texture(uCloudVol, q / ${CLOUD_SCALES.coverage.toFixed(1)}).r
            + 0.35 * texture(uCloudVol, q / ${CLOUD_SCALES.secondary.toFixed(1)} + vec3(${OFF2.join(", ")})).r;
  float shape = clamp((cov - (1.0 - uCoverage)) / 0.22, 0.0, 1.0)
              * smoothstep(0.0, 0.18, h) * smoothstep(1.0, 0.55, h);
  if (shape <= 0.0) return 0.0;
  float erode = texture(uCloudVol, q / ${CLOUD_SCALES.erosion.toFixed(1)} + vec3(${OFF3.join(", ")})).r;
  return clamp(shape - (1.0 - shape) * erode * 0.7, 0.0, 1.0);
}`;

/** Procedural 32^3 tiling value-noise volume (fallback when the .bin can't load). */
export function makeVolumeNoiseData(seed: number, size = 32): Uint8Array {
  let a = seed >>> 0 || 1;
  const rand = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const data = new Uint8Array(size * size * size);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(rand() * 256);
  return data;
}

/** Parse Shadertoy's volume format ("BIN\\n" + w, h, d, channels int32 + bytes). */
export function parseShadertoyVolume(buffer: ArrayBuffer): { size: number; data: Uint8Array } {
  const view = new DataView(buffer);
  const sig = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2));
  if (sig !== "BIN") throw new Error("bad volume header");
  const w = view.getInt32(4, true);
  const h = view.getInt32(8, true);
  const d = view.getInt32(12, true);
  const ch = view.getInt32(16, true);
  if (w !== h || h !== d || ch !== 1) throw new Error(`unsupported volume ${w}x${h}x${d}x${ch}`);
  if (buffer.byteLength < 20 + w * h * d) throw new Error("truncated volume");
  return { size: w, data: new Uint8Array(buffer.slice(20, 20 + w * h * d)) };
}
