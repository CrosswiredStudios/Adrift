import { Vector3 } from "@babylonjs/core";
import { glslNum } from "./shaderChunks";

/**
 * Analytic ocean wave source: a small spectral sum of Gerstner waves laid out
 * as three cascades (swell / wind / chop) plus a slow radial "swash" wave that
 * drives run-up on beaches.
 *
 * This module is the swap boundary for a future FFT source: everything the
 * renderer needs is (a) the packed uniform arrays below, (b) `WAVE_GLSL`, and
 * (c) the CPU mirrors used by the flight model. The reference demo
 * (Popov72/OceanDemo, port of gasgiant/FFT-Ocean) uses WebGPU compute FFT;
 * this game is WebGL2 + headless-SwiftShader tested, so the same cascade
 * structure (cascade scales, distance-based LOD fade, slope/jacobian foam) is
 * produced analytically instead.
 *
 * Sphere geometry: each wave is a plane-wave family whose axis `A` is a unit
 * 3D vector; phase = k * dot(A, p) - w t. Crests are circles around the axis,
 * the local wavenumber is k * |A - n (A.n)| (so waves flatten toward the axis
 * poles, which also hides the direction singularity there), and the travel
 * direction at a point is the tangent projection of the axis.
 */

export type SeaState = "calm" | "mild" | "rough";

export const MAX_WAVES = 12;
export const WAVE_CASCADES = 3;

/** Gravity used for deep-water dispersion in this world (units ~ metres). */
const G = 9.81;

export interface WaveComponent {
  /** Unit axis the wave travels toward (crests are circles around it). */
  axis: Vector3;
  /** Arc wavelength at the axis' equator, world units. */
  wavelength: number;
  /** Amplitude, world units. */
  amplitude: number;
  /** Deep-water phase speed, units/s. */
  speed: number;
  /** Horizontal (Gerstner) displacement as a multiple of the amplitude. */
  horiz: number;
  /** Phase offset so cascades do not align on the axis plane. */
  phase: number;
  /** 0 swell, 1 wind, 2 chop. */
  cascade: number;
}

export interface SwashParams {
  axis: Vector3;
  lambdaA: number; ampA: number; speedA: number;
  lambdaB: number; ampB: number; speedB: number;
  /** Phase lag per unit of shallowness (run-up trails the breaker). */
  retard: number;
}

export interface WaveSet {
  components: WaveComponent[];
  count: number;
  /** Packed for the vertex shader: 12 x vec4 (xyz axis, w cascade). */
  axes: Float32Array;
  /** Packed for the vertex shader: 12 x vec4 (wavelength, amplitude, speed, horiz). */
  params: Float32Array;
  /** Packed phase offsets: 12 floats. */
  phases: Float32Array;
  swash: SwashParams;
  /** Per-cascade depth (world units) at which shoaling becomes noticeable. */
  surfScale: Vector3;
}

export interface WaveSettings {
  seaState: SeaState;
  /** Unit world direction the dominant swell travels toward. */
  windAxis?: Vector3;
  /** Extra multiplier on all amplitudes (debug / gameplay). */
  heightScale?: number;
}

/** Per sea state: [swellA, swellB, wind, chop] base amplitudes (world units). */
const SEA_STATES: Record<SeaState, { swell: number; wind: number; chop: number; q: number }> = {
  calm: { swell: 0.10, wind: 0.045, chop: 0.022, q: 0.55 },
  mild: { swell: 0.17, wind: 0.075, chop: 0.034, q: 0.75 },
  rough: { swell: 0.30, wind: 0.13, chop: 0.06, q: 1.0 },
};

const SWELL_LAMBDAS = [130, 95];
const WIND_LAMBDAS = [44, 32, 24, 19];
const CHOP_LAMBDAS = [13, 9.5, 7];

function phaseSpeed(lambda: number): number {
  return Math.sqrt((G * lambda) / (2 * Math.PI));
}

/** Deterministic little RNG (seed -> [0,1)). */
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

/** Rotate `axis` toward `perp` by `deg` degrees (helps spread a cascade). */
function tiltAxis(axis: Vector3, perp: Vector3, deg: number): Vector3 {
  const a = (deg * Math.PI) / 180;
  return axis.scale(Math.cos(a)).addInPlace(perp.scale(Math.sin(a))).normalize();
}

export function buildWaveSet(settings: WaveSettings, seed: number): WaveSet {
  const st = SEA_STATES[settings.seaState];
  const heightScale = settings.heightScale ?? 1;
  const rand = rng(seed + 91);

  // Dominant travel direction: mostly horizontal, tilted a little by the seed so
  // the "calm" spots at the axis poles do not sit on the equator line.
  const windDir = (seed % 360) * (Math.PI / 180);
  const base = settings.windAxis
    ? settings.windAxis.clone().normalize()
    : new Vector3(Math.cos(windDir), 0.22 + rand() * 0.2, Math.sin(windDir)).normalize();

  // Perpendicular used to spread component directions around the base axis.
  const perp = Vector3.Cross(base, new Vector3(0.13, 1, -0.21)).normalize();
  const perp2 = Vector3.Cross(base, perp).normalize();

  const components: WaveComponent[] = [];
  const push = (
    cascade: number, lambda: number, amp: number, spreadDeg: number, tiltDeg: number
  ): void => {
    const axis = tiltAxis(tiltAxis(base, perp, spreadDeg), perp2, tiltDeg);
    components.push({
      axis,
      wavelength: lambda,
      amplitude: amp * heightScale,
      speed: phaseSpeed(lambda),
      horiz: 0,
      phase: (rand() - 0.5) * Math.PI * 1.4,
      cascade,
    });
  };

  // Swell: two long, low, smooth (low choppiness) waves.
  push(0, SWELL_LAMBDAS[0], st.swell * 0.8, -6, 2);
  push(0, SWELL_LAMBDAS[1], st.swell, 5, -3);
  // Wind sea: the main choppy train.
  for (let i = 0; i < WIND_LAMBDAS.length; i++) {
    push(1, WIND_LAMBDAS[i], st.wind * (1 - i * 0.12), -14 + i * 9, (i % 2 === 0 ? 1 : -1) * (4 + i * 2));
  }
  // Chop: small, quickly LOD-faded (mostly felt as normal detail near the camera).
  for (let i = 0; i < CHOP_LAMBDAS.length; i++) {
    push(2, CHOP_LAMBDAS[i], st.chop * (1 - i * 0.15), 20 - i * 13, (i % 2 === 0 ? -1 : 1) * 9);
  }

  // Gerstner horizontal displacement: keep the summed steepness (sum of
  // horiz * k * A) below ~1 so the surface cannot fold onto itself.
  const perCascade = [2, WIND_LAMBDAS.length, CHOP_LAMBDAS.length];
  for (let c = 0; c < WAVE_CASCADES; c++) {
    const members = components.filter((w) => w.cascade === c);
    if (members.length === 0) continue;
    const steep = st.q / members.length;
    for (const w of members) {
      const k = (2 * Math.PI) / w.wavelength;
      const full = steep / Math.max(k * w.amplitude, 1e-5);
      w.horiz = Math.min(full, 1.35);
    }
  }
  void perCascade;

  const swash: SwashParams = {
    axis: tiltAxis(base, perp, 4).clone(),
    lambdaA: 84, ampA: 0.17 * heightScale, speedA: phaseSpeed(84),
    lambdaB: 47, ampB: 0.075 * heightScale, speedB: phaseSpeed(47),
    retard: 0.55,
  };

  const count = components.length;
  const axes = new Float32Array(MAX_WAVES * 4);
  const params = new Float32Array(MAX_WAVES * 4);
  const phases = new Float32Array(MAX_WAVES);
  for (let i = 0; i < MAX_WAVES; i++) {
    const w = components[i];
    if (!w) {
      params[i * 4 + 1] = 0; // zero amplitude: skipped in the shader
      continue;
    }
    axes[i * 4 + 0] = w.axis.x;
    axes[i * 4 + 1] = w.axis.y;
    axes[i * 4 + 2] = w.axis.z;
    axes[i * 4 + 3] = w.cascade;
    params[i * 4 + 0] = w.wavelength;
    params[i * 4 + 1] = w.amplitude;
    params[i * 4 + 2] = w.speed;
    params[i * 4 + 3] = w.horiz;
    phases[i] = w.phase;
  }

  return {
    components,
    count,
    axes,
    params,
    phases,
    swash,
    surfScale: new Vector3(34, 13, 5),
  };
}

// --- CPU mirrors (flight model / buoyancy) --------------------------------

export function cpuSwashRise(swash: SwashParams, p: Vector3, time: number, shallow = 0): number {
  const kA = (2 * Math.PI) / swash.lambdaA;
  const kB = (2 * Math.PI) / swash.lambdaB;
  const phase = kA * Vector3.Dot(swash.axis, p) - kA * swash.speedA * time
    - swash.retard * shallow;
  const phaseB = kB * Vector3.Dot(swash.axis, p) - kB * swash.speedB * time
    - swash.retard * shallow * 0.6;
  return (swash.ampA * Math.sin(phase) + swash.ampB * Math.sin(phaseB)) * (0.75 + 0.6 * shallow);
}

/** Radial wave height at a world position (wind waves + swash), world units. */
export function cpuWaveHeightAt(set: WaveSet, p: Vector3, time: number, shallow = 0): number {
  let h = 0;
  for (let i = 0; i < set.count; i++) {
    const w = set.components[i];
    const k = (2 * Math.PI) / w.wavelength;
    const phase = k * Vector3.Dot(w.axis, p) + w.phase - k * w.speed * time;
    h += w.amplitude * Math.sin(phase);
  }
  return h + cpuSwashRise(set.swash, p, time, shallow);
}

/**
 * Approximate surface normal from three CPU height samples around `dir`
 * (unit, from the planet centre). Writes into `out`.
 */
export function cpuWaveNormalAt(
  set: WaveSet, center: Vector3, dir: Vector3, radius: number, time: number, out: Vector3
): Vector3 {
  const t = Math.abs(dir.y) < 0.9
    ? Vector3.Cross(dir, new Vector3(0, 1, 0)).normalize()
    : Vector3.Cross(dir, new Vector3(1, 0, 0)).normalize();
  const b = Vector3.Cross(dir, t).normalize();
  const eps = 3;
  const half = eps / radius;
  const p0 = center.add(dir.scale(radius));
  const pt = center.add(dir.add(t.scale(half)).normalize().scale(radius));
  const pb = center.add(dir.add(b.scale(half)).normalize().scale(radius));
  const h0 = cpuWaveHeightAt(set, p0, time);
  const ht = cpuWaveHeightAt(set, pt, time);
  const hb = cpuWaveHeightAt(set, pb, time);
  const slopeT = (ht - h0) / eps;
  const slopeB = (hb - h0) / eps;
  return out.copyFrom(dir).addInPlace(t.scale(-slopeT)).addInPlace(b.scale(-slopeB)).normalize();
}

/**
 * GLSL chunk: per-cascade shoaling/breaking/refraction of the wave sum.
 * Declares its uniforms; list them in the material's uniform array:
 *   uWaveAxis (vec4[12]), uWaveParam (vec4[12]), uWavePhase (float[12]),
 *   uWaveCount, uLodScale, uTime, uSurfScale (vec3), uShoalGain, uBreakCoef,
 *   uRefractAmt, uChopEnable, uGeomFade (vec2: near, far)
 */
export const WAVE_GLSL = `
uniform vec4 uWaveAxis[12];
uniform vec4 uWaveParam[12];
uniform float uWavePhase[12];
uniform float uWaveCount;
uniform float uLodScale;
uniform float uTime;
uniform vec3 uSurfScale;
uniform float uShoalGain;
uniform float uBreakCoef;
uniform float uRefractAmt;
uniform float uChopEnable;
uniform vec2 uGeomFade;

float waveLod(float lambda, float dist) {
  return clamp(uLodScale * lambda / max(dist, 1.0), 0.0, 1.0);
}

/**
 * Sum the wave field at world position p (on the mean sea sphere, radial
 * direction n). depth = water depth in world units (negative on land),
 * shoreDir = unit onshore direction in the tangent plane, tA/bA = tangent frame.
 * dispRad = radial offset (geometry), dispTan = tangent offset (geometry),
 * nrm = analytic surface normal, breaking = whitewater amount 0..1.
 */
void oceanWaveSum(
  vec3 p, vec3 n, float dist, float depth, vec3 shoreDir, vec3 tA, vec3 bA,
  out float dispRad, out vec3 dispTan, out vec3 nrm, out float breaking
) {
  float Jtt = 0.0; float Jtb = 0.0; float Jbb = 0.0;
  float Nt = 0.0; float Nb = 0.0;
  dispRad = 0.0; dispTan = vec3(0.0); breaking = 0.0;
  float geomW = 1.0 - smoothstep(uGeomFade.x, uGeomFade.y, dist);

  for (int i = 0; i < 12; i++) {
    if (float(i) >= uWaveCount) break;
    vec4 axisP = uWaveAxis[i];
    vec4 par = uWaveParam[i];
    float amp = par.y;
    if (amp <= 0.0) continue;
    vec3 A = axisP.xyz;
    int casc = int(axisP.w + 0.5);
    float lambda = par.x;
    float k = 6.283185307 / lambda;

    // Tangent projection of the axis: its length is sin(angle to the axis) and
    // doubles as the local-wavenumber scale (waves flatten at the axis poles).
    vec3 T = A - n * dot(A, n);
    float tLen = length(T);
    float fade = smoothstep(0.015, 0.16, tLen);
    vec3 Tn = tLen > 1e-4 ? T / tLen : tA;
    float kL = k * tLen * fade;

    float shoalScale = uSurfScale.x;
    if (casc == 1) shoalScale = uSurfScale.y;
    else if (casc == 2) shoalScale = uSurfScale.z;
    float shallow = clamp(1.0 - depth / max(shoalScale, 0.5), 0.0, 1.0);

    float lodW = waveLod(lambda, dist);
    if (casc == 2) lodW *= uChopEnable;
    float ampNow = amp * fade * lodW;
    if (ampNow <= 0.0) continue;

    float hScale = par.w;
    if (shallow > 0.001) {
      // Shoaling growth, break cap, crest skew, refraction toward the shore.
      float ampShoal = ampNow * (1.0 + uShoalGain * shallow);
      float cap = uBreakCoef * max(depth, 0.0);
      if (ampShoal > cap) {
        breaking += (ampShoal - cap) / max(ampShoal, 1e-4);
        ampShoal = cap;
      }
      ampNow = ampShoal;
      hScale = par.w * (1.0 + 1.4 * shallow);
      Tn = normalize(mix(Tn, shoreDir, clamp(uRefractAmt * shallow, 0.0, 1.0)));
    }

    float phase = k * dot(A, p) + uWavePhase[i] - k * par.z * uTime;
    float s = sin(phase);
    float co = cos(phase);

    dispRad += ampNow * s * geomW;
    if (hScale > 0.0) dispTan += Tn * (ampNow * hScale * co * geomW);

    float a = dot(Tn, tA);
    float b = dot(Tn, bA);
    float hs = ampNow * hScale * kL * s;
    Jtt += -hs * a * a;
    Jtb += -hs * a * b;
    Jbb += -hs * b * b;
    float nv = ampNow * kL * co;
    Nt += nv * a;
    Nb += nv * b;
  }

  breaking = clamp(breaking, 0.0, 1.0);
  vec3 t1 = tA * (1.0 + Jtt) + bA * Jtb + n * Nt;
  vec3 t2 = tA * Jtb + bA * (1.0 + Jbb) + n * Nb;
  nrm = normalize(cross(t1, t2));
}`;

/** GLSL chunk for the run-up wave (shared with the wet-sand ground shader). */
export function swashGLSL(swash: SwashParams): string {
  const axis = swash.axis;
  return `
const vec3 SWASH_AXIS = vec3(${glslNum(axis.x)}, ${glslNum(axis.y)}, ${glslNum(axis.z)});
const float SWASH_K_A = ${glslNum((2 * Math.PI) / swash.lambdaA)};
const float SWASH_W_A = ${glslNum(((2 * Math.PI) / swash.lambdaA) * swash.speedA)};
const float SWASH_K_B = ${glslNum((2 * Math.PI) / swash.lambdaB)};
const float SWASH_W_B = ${glslNum(((2 * Math.PI) / swash.lambdaB) * swash.speedB)};
const float SWASH_AMP_A = ${glslNum(swash.ampA)};
const float SWASH_AMP_B = ${glslNum(swash.ampB)};
const float SWASH_RETARD = ${glslNum(swash.retard)};

/** Primary run-up phase (drives foam timing / wet-sand state). */
float swashPhaseA(vec3 p, float time, float shallow) {
  return SWASH_K_A * dot(SWASH_AXIS, p) - SWASH_W_A * time - SWASH_RETARD * shallow;
}

/**
 * Run-up: radial water offset at world position p (world units).
 * shallow = 0 in deep water, 1 at the waterline (delays the phase so breakers
 * arrive before the swash).
 */
float swashRise(vec3 p, float time, float shallow) {
  float lag = SWASH_RETARD * shallow;
  float rise = SWASH_AMP_A * sin(SWASH_K_A * dot(SWASH_AXIS, p) - SWASH_W_A * time - lag)
             + SWASH_AMP_B * sin(SWASH_K_B * dot(SWASH_AXIS, p) - SWASH_W_B * time - lag * 0.6 + 1.1);
  return rise * (0.75 + 0.6 * shallow);
}

/** Analytic slope of the run-up along two tangent directions (for normals). */
void swashSlope(vec3 p, float time, float shallow, vec3 tA, vec3 bA, out float slopeT, out float slopeB) {
  float lag = SWASH_RETARD * shallow;
  float dA = SWASH_AMP_A * SWASH_K_A * cos(SWASH_K_A * dot(SWASH_AXIS, p) - SWASH_W_A * time - lag);
  float dB = SWASH_AMP_B * SWASH_K_B * cos(SWASH_K_B * dot(SWASH_AXIS, p) - SWASH_W_B * time - lag * 0.6 + 1.1);
  float d = (dA + dB) * (0.75 + 0.6 * shallow);
  slopeT = d * dot(SWASH_AXIS, tA);
  slopeB = d * dot(SWASH_AXIS, bA);
}`;
}
