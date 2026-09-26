import { Color3 } from "@babylonjs/core";

/** Format a number for GLSL source (always keeps a decimal point). */
export function glslNum(v: number): string {
  const s = v.toFixed(6);
  return s.includes(".") ? s : s + ".0";
}

/** Format a Color3 as a GLSL vec3 constructor. */
export function glslColor(c: Color3): string {
  return `vec3(${glslNum(c.r)}, ${glslNum(c.g)}, ${glslNum(c.b)})`;
}

/**
 * Cheap visual-only noise (no CPU twin needed): used for foam breakup and
 * ripple normal detail. Same family as the cloud shader's inline helpers.
 */
export const FAST_NOISE_GLSL = `
float waterHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float waterNoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = waterHash(i); float n100 = waterHash(i + vec3(1,0,0));
  float n010 = waterHash(i + vec3(0,1,0)); float n110 = waterHash(i + vec3(1,1,0));
  float n001 = waterHash(i + vec3(0,0,1)); float n101 = waterHash(i + vec3(1,0,1));
  float n011 = waterHash(i + vec3(0,1,1)); float n111 = waterHash(i + vec3(1,1,1));
  return mix(mix(mix(n000,n100,f.x), mix(n010,n110,f.x), f.y),
             mix(mix(n001,n101,f.x), mix(n011,n111,f.x), f.y), f.z);
}
float waterFbm(vec3 p, int octaves) {
  float s = 0.0; float a = 0.5; float norm = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= octaves) break;
    s += a * waterNoise(p);
    norm += a;
    p *= 2.03;
    a *= 0.5;
  }
  return s / max(norm, 1e-4);
}`;

/**
 * Analytic sky approximation matching the atmosphere palette (see
 * `atmosphere.ts`). Used for water reflections and wet-sand sheen; the
 * palette is baked into the source per planet (see `skyGLSL`).
 */
export interface SkyPalette {
  skyTint: Color3;
  skyStrength: number;
  hazeTint: Color3;
  hazeStrength: number;
  hazeG: number;
  sunTint: Color3;
  sunGlow: number;
}

export function skyGLSL(p: SkyPalette): string {
  return `
const vec3 SKY_TINT = ${glslColor(p.skyTint)};
const float SKY_STR = ${glslNum(p.skyStrength)};
const vec3 HAZE_TINT = ${glslColor(p.hazeTint)};
const float HAZE_STR = ${glslNum(p.hazeStrength)};
const float HAZE_G = ${glslNum(p.hazeG)};
const vec3 SUN_TINT = ${glslColor(p.sunTint)};
const float SUN_GLOW = ${glslNum(p.sunGlow)};

float skyPhaseMie(float mu, float g) {
  float g2 = g * g;
  float num = (1.0 - g2) * (1.0 + mu * mu);
  float den = (2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-3), 1.5);
  return num / den;
}

/** Sky radiance along a ray direction; up = local planet up, sunToward = unit vector toward the star. */
vec3 skyColor(vec3 dir, vec3 up, vec3 sunToward) {
  float h = clamp(dot(dir, up), -1.0, 1.0);
  float day = smoothstep(-0.15, 0.22, dot(up, sunToward));
  float mu = clamp(dot(dir, sunToward), -1.0, 1.0);
  float horizon = pow(clamp(1.0 - h, 0.0, 1.0), 1.6);
  vec3 col = SKY_TINT * SKY_STR * (0.35 + 0.65 * clamp(h * 0.5 + 0.5, 0.0, 1.0));
  col += HAZE_TINT * HAZE_STR * (0.25 + 1.4 * horizon) * (0.35 + 0.9 * skyPhaseMie(mu, HAZE_G));
  col += SUN_TINT * SUN_GLOW * pow(max(mu, 0.0), 10.0);
  return col * day;
}`;
}

/** Small math helpers shared by the ocean shaders. */
export const OCEAN_MATH_GLSL = `
float saturate1(float v) { return clamp(v, 0.0, 1.0); }
vec3 saturate3(vec3 v) { return clamp(v, vec3(0.0), vec3(1.0)); }
float remap01(float v, float a, float b) { return saturate1((v - a) / max(b - a, 1e-5)); }
`;
