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
  /** Evolution speed of the noise layers (m/s scale; 0 = frozen shapes). */
  evolve: number;
}

/** Tile sizes (m) of the 32^3 noise volume per layer (features are ~1/32 of these). */
export const CLOUD_SCALES = { weather: 20000, coverage: 4500, secondary: 1600, erosion: 260 } as const;
const OFF2: [number, number, number] = [0.37, 0.11, 0.73];
const OFF3: [number, number, number] = [0.61, 0.29, 0.17];
const OFF4: [number, number, number] = [0.13, 0.83, 0.47];
const OFF0: [number, number, number] = [0, 0, 0];

/**
 * Evolution: each noise layer drifts through the deck in its own direction
 * (metres per second per unit of `evolve`), so clouds build, merge and
 * dissolve instead of sliding by as a rigid pattern - the effect of the
 * Babylon volumetric-clouds playground (#MAONNT), a little slower.
 */
const DRIFT = {
  weather: [0.5, 0, 0.2],
  coverage: [1, 0, 0.3],
  secondary: [-0.6, 0.4, 1.2],
  erosion: [0.8, 1.5, -0.5],
} as const;

/**
 * Weather: a very low-frequency field that scales the local coverage, so
 * the planet has clear regions, broken cloud and overcast patches instead
 * of one uniform deck. Returns the coverage multiplier (0.1 .. ~1.5).
 */
function weatherScale(w: number): number {
  const t = sat((w - 0.3) / 0.45);
  return 0.1 + 1.4 * t * t * (3 - 2 * t);
}

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
  const e = p.evolve * time;
  const at = (scale: number, drift: readonly number[], off: readonly number[]): number =>
    vol.sample(
      (qx + drift[0] * e) / scale + off[0],
      (qy + drift[1] * e) / scale + off[1],
      (qz + drift[2] * e) / scale + off[2],
    );
  const localCoverage = sat(p.coverage * weatherScale(at(S.weather, DRIFT.weather, OFF4)));
  const cov = 0.8 * at(S.coverage, DRIFT.coverage, OFF0) + 0.2 * at(S.secondary, DRIFT.secondary, OFF2);
  // Cloudiness 0..1; denser cores tower higher (tops between 30% and 100% of the deck).
  const core = sat((cov - (1 - localCoverage)) / 0.3);
  const top = 0.3 + 0.7 * core;
  const shape = core * smooth(0, 0.12, h) * smooth(top, top - 0.45, h);
  if (shape <= 0) return 0;
  const erode = at(S.erosion, DRIFT.erosion, OFF3);
  return sat(shape - (1 - shape) * erode * 0.5);
}

/** GLSL twin of cloudDensityAt (needs `uniform sampler3D uCloudVol` and CloudParams uniforms). */
export const CLOUD_DENSITY_GLSL = `
vec3 cloudDrift(vec3 d) { return d * uEvolve * uTime; }
float cloudDensity(vec3 p) {
  float r = length(p);
  float h = (r - (uPlanetRadius + uCloudBase)) / uCloudThickness;
  if (h <= 0.0 || h >= 1.0) return 0.0;
  float a = -uWindRate * uTime;
  float c = cos(a);
  float s = sin(a);
  vec3 q = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
  float wth = clamp((texture(uCloudVol, (q + cloudDrift(vec3(${DRIFT.weather.join(", ")}))) / ${CLOUD_SCALES.weather.toFixed(1)}
                     + vec3(${OFF4.join(", ")})).r - 0.3) / 0.45, 0.0, 1.0);
  float localCoverage = clamp(uCoverage * (0.1 + 1.4 * wth * wth * (3.0 - 2.0 * wth)), 0.0, 1.0);
  float cov = 0.8 * texture(uCloudVol, (q + cloudDrift(vec3(${DRIFT.coverage.join(", ")}))) / ${CLOUD_SCALES.coverage.toFixed(1)}
                     + vec3(${OFF0.join(", ")})).r
            + 0.2 * texture(uCloudVol, (q + cloudDrift(vec3(${DRIFT.secondary.join(", ")}))) / ${CLOUD_SCALES.secondary.toFixed(1)}
                     + vec3(${OFF2.join(", ")})).r;
  float core = clamp((cov - (1.0 - localCoverage)) / 0.3, 0.0, 1.0);
  float top = 0.3 + 0.7 * core;
  float shape = core * smoothstep(0.0, 0.12, h) * smoothstep(top, top - 0.45, h);
  if (shape <= 0.0) return 0.0;
  float erode = texture(uCloudVol, (q + cloudDrift(vec3(${DRIFT.erosion.join(", ")}))) / ${CLOUD_SCALES.erosion.toFixed(1)}
                     + vec3(${OFF3.join(", ")})).r;
  return clamp(shape - (1.0 - shape) * erode * 0.5, 0.0, 1.0);
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
