/**
 * Physical atmosphere model shared by the sky shader and the CPU lighting.
 *
 * Exponential Rayleigh + Mie layers (single scattering). Coefficients are
 * derived from each body's data so that the *optical depth* matches a
 * familiar sky even though the atmospheres here are only hundreds of meters
 * thick: beta = tau_zenith / scaleHeight. Earth's zenith optical depths are
 * ~(0.046, 0.108, 0.265) for Rayleigh and ~0.025 for Mie.
 *
 * The CPU functions mirror the shader's integration, so the sunlight that
 * lights the terrain is dimmed and reddened by exactly the air the sky pass
 * draws (sunsets on the ground match sunsets in the sky).
 */
import type { AtmosphereSpec } from "../data/system";

export interface AtmoParams {
  /** Radius below which rays are blocked (sea level / mean radius), m. */
  groundRadius: number;
  /** Top of the atmosphere, m from the centre. */
  topRadius: number;
  betaR: [number, number, number];
  betaM: number;
  betaMExt: number;
  hR: number;
  hM: number;
  mieG: number;
}

const EARTH_TAU_R_BLUE = 0.265;
const EARTH_TAU_M = 0.025;

export function atmoParams(radius: number, groundRadius: number, a: AtmosphereSpec): AtmoParams {
  const kR = (EARTH_TAU_R_BLUE * a.rayleighStrength) / a.rayleighScale;
  const betaM = (EARTH_TAU_M * a.mieStrength) / a.mieScale;
  return {
    groundRadius,
    topRadius: radius + a.height,
    betaR: [a.rayleighColor.r * kR, a.rayleighColor.g * kR, a.rayleighColor.b * kR],
    betaM,
    betaMExt: betaM * 1.11,
    hR: a.rayleighScale,
    hM: a.mieScale,
    mieG: a.mieG,
  };
}

/** Ray/sphere intersection: [t0, t1] or null (origin relative to the centre). */
export function raySphere(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  r: number,
): [number, number] | null {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const h = b * b - c;
  if (h < 0) return null;
  const s = Math.sqrt(h);
  return [-b - s, -b + s];
}

/**
 * Transmittance (rgb) of sunlight reaching point p (relative to the body
 * centre) from direction `toSun` (unit). Zero when the planet blocks the sun.
 */
export function sunTransmittance(
  P: AtmoParams,
  px: number,
  py: number,
  pz: number,
  sx: number,
  sy: number,
  sz: number,
  steps = 12,
): [number, number, number] {
  const ground = raySphere(px, py, pz, sx, sy, sz, P.groundRadius);
  if (ground && ground[1] > 0 && ground[0] > 0) return [0, 0, 0];
  const top = raySphere(px, py, pz, sx, sy, sz, P.topRadius);
  const r0 = Math.hypot(px, py, pz);
  if (!top || top[1] <= 0) return [1, 1, 1];
  const t1 = top[1];
  const t0 = r0 > P.topRadius ? Math.max(0, top[0]) : 0;
  const ds = (t1 - t0) / steps;
  let dR = 0;
  let dM = 0;
  for (let i = 0; i < steps; i++) {
    const t = t0 + (i + 0.5) * ds;
    const h = Math.hypot(px + sx * t, py + sy * t, pz + sz * t) - P.groundRadius;
    dR += Math.exp(-Math.max(h, 0) / P.hR) * ds;
    dM += Math.exp(-Math.max(h, 0) / P.hM) * ds;
  }
  return [
    Math.exp(-(P.betaR[0] * dR + P.betaMExt * dM)),
    Math.exp(-(P.betaR[1] * dR + P.betaMExt * dM)),
    Math.exp(-(P.betaR[2] * dR + P.betaMExt * dM)),
  ];
}

/** 0..1 how much sky light surrounds a point (for ambient + stars fading). */
export function skyAmount(P: AtmoParams, altitudeAboveGround: number): number {
  const h = Math.max(0, altitudeAboveGround);
  return Math.exp(-h / (P.hR * 1.6)) * (h < P.topRadius - P.groundRadius ? 1 : 0);
}

/** GLSL for the same model (used by the sky/aerial-perspective pass). */
export const ATMOSPHERE_GLSL = `
vec2 raySphere(vec3 o, vec3 d, float r) {
  float b = dot(o, d);
  float c = dot(o, o) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(1e20, -1e20);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}
float phaseRayleigh(float mu) { return 0.0596831 * (1.0 + mu * mu); }
float phaseMie(float mu, float g) {
  float g2 = g * g;
  return 0.1193662 * (1.0 - g2) * (1.0 + mu * mu) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}`;
