/**
 * Sky, aerial perspective and volumetric clouds as one post-process chain,
 * running on the HDR scene colour *before* bloom and tone mapping.
 *
 *   scene ─► [copy] ─► [clouds, low res] ─► [composite, full res] ─► HDR pipeline
 *              │                                 ▲
 *              └────── full-res scene colour ────┘
 *
 * - View rays are rebuilt from the camera's actual basis (right/up/forward
 *   from its world matrix), so a rolled camera stays registered with the
 *   scene.
 * - The clouds are raymarched at reduced resolution into their *own* target
 *   (premultiplied scattering + coverage) and composited at full resolution;
 *   the scene itself is never downsampled.
 * - Depth comes from one scene-wide depth texture (camera-space z, float)
 *   that contains every opaque mesh, so clouds and haze sit correctly in
 *   front of or behind the ship, trees and terrain.
 * - The atmosphere is single-scattered Rayleigh + Mie integrated along each
 *   ray (sky, sunsets, planet limbs from space, haze over distant terrain),
 *   for up to two bodies, with the same model the CPU uses to colour the
 *   sunlight (render/atmosphereModel.ts).
 */
import {
  Camera,
  Color3,
  Constants,
  Effect,
  Engine,
  Matrix,
  PassPostProcess,
  PostProcess,
  RawTexture3D,
  Scene,
  Texture,
  Vector3,
} from "@babylonjs/core";
import { ATMOSPHERE_GLSL, type AtmoParams } from "./atmosphereModel";
import {
  CLOUD_DENSITY_GLSL,
  CloudVolumeData,
  makeVolumeNoiseData,
  parseShadertoyVolume,
  type CloudParams,
} from "./cloudModel";

export const MAX_ATMO_BODIES = 2;

export interface AtmoBodyFrame {
  /** Body centre in render space. */
  center: Vector3;
  params: AtmoParams;
}

export interface CloudFrame {
  /** Body centre in render space. */
  center: Vector3;
  /** Render -> body rotation (3x3, row-major in a Matrix). */
  worldToBody: Matrix;
  params: CloudParams;
  /** Sun direction (toward the sun) in the body frame. */
  sunLocal: Vector3;
  /**
   * Sunlight above the atmosphere (HDR). The shader dims and reddens it per
   * cloud sample through `atmo` and the planet's shadow, so the night side
   * is dark and the terminator glows.
   */
  sunColor: Color3;
  /** Atmosphere the sunlight passes through on its way to the deck (null = airless). */
  atmo: AtmoParams | null;
  /** Ambient sky light on the clouds where the sun is high (HDR). */
  ambientDay: Color3;
  /** Ambient on the night side (starlight, HDR). */
  ambientNight: Color3;
  time: number;
  /** Haze (Mie) scale height of the atmosphere (m), for light shafts. */
  hazeScale: number;
}

export interface PlanetaryFrame {
  /** Unit vector toward the star (render space). */
  sunDir: Vector3;
  /** Star illuminance for sky scattering (HDR). */
  sunIlluminance: Color3;
  /** Ordered far -> near. */
  bodies: AtmoBodyFrame[];
  clouds: CloudFrame | null;
  /**
   * The sea surface of the focus body (render-space centre, radius). The
   * water is transparent, so it isn't in the depth texture; the passes
   * intersect this sphere themselves so haze, clouds and shafts stop at the
   * water instead of at the sea floor.
   */
  sea: { center: Vector3; radius: number } | null;
}

export type SkyQuality = "ultra" | "high" | "balanced" | "lite";

const QUALITY: Record<
  SkyQuality,
  { cloudSteps: number; lightSteps: number; atmoSteps: number; shafts: boolean; shadows: boolean }
> = {
  ultra: { cloudSteps: 64, lightSteps: 6, atmoSteps: 16, shafts: true, shadows: true },
  high: { cloudSteps: 48, lightSteps: 5, atmoSteps: 14, shafts: true, shadows: true },
  balanced: { cloudSteps: 28, lightSteps: 4, atmoSteps: 10, shafts: false, shadows: true },
  lite: { cloudSteps: 0, lightSteps: 0, atmoSteps: 8, shafts: false, shadows: false },
};

/** Share of ground lighting that is direct sun (what a cloud shadow removes). */
const SHADOW_AMOUNT = 0.72;
/** Light shafts: strength, and the sun-visibility level that reads as "neutral". */
const SHAFT_STRENGTH = 0.005;
const SHAFT_BIAS = 0.65;

const CLOUD_DECK_UNIFORMS = [
  "uBodyCenter",
  "uWorldToBody",
  "uPlanetRadius",
  "uCloudBase",
  "uCloudThickness",
  "uCoverage",
  "uExtinction",
  "uWindRate",
  "uEvolve",
  "uTime",
  "uSunLocal",
];

/** Cloud-deck uniforms shared by the cloud raymarch and the composite. */
const CLOUD_UNIFORMS_GLSL = `
uniform sampler3D uCloudVol;
uniform vec3 uBodyCenter;
uniform mat4 uWorldToBody;
uniform float uPlanetRadius;
uniform float uCloudBase;
uniform float uCloudThickness;
uniform float uCoverage;
uniform float uExtinction;
uniform float uWindRate;
uniform float uEvolve;
uniform float uTime;
uniform vec3 uSunLocal;
`;

/**
 * Transmittance of sunlight through the cloud deck from body-frame point p
 * (6 density samples between p, or the deck base, and the deck top).
 */
const CLOUD_SHADOW_GLSL = `
float cloudShadow(vec3 p) {
  float rb = uPlanetRadius + uCloudBase;
  float rt = rb + uCloudThickness;
  float pp = dot(p, p);
  if (pp > rt * rt) return 1.0;
  float b = dot(p, uSunLocal);
  float ht = b * b - (pp - rt * rt);
  if (ht < 0.0) return 1.0;
  float t1 = -b + sqrt(ht);
  float t0 = 0.0;
  if (pp < rb * rb) t0 = -b + sqrt(max(b * b - (pp - rb * rb), 0.0));
  if (t1 <= t0) return 1.0;
  float dt = (t1 - t0) / 6.0;
  float od = 0.0;
  for (int i = 0; i < 6; i++) od += cloudDensity(p + uSunLocal * (t0 + (float(i) + 0.5) * dt));
  return exp(-od * dt * uExtinction * 0.6);
}
`;
/** Cloud buffer resolution relative to the screen. */
const CLOUD_SCALE = 0.5;

const CAMERA_GLSL = `
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform vec2 uTanHalf; // tan(fov/2) * aspect, tan(fov/2)
uniform vec4 uSea; // sea sphere: render-space centre, radius (0 = none)
uniform sampler2D uDepth;
vec3 viewRay(vec2 uv) {
  vec2 s = uv * 2.0 - 1.0;
  return uCamFwd + uCamRight * (s.x * uTanHalf.x) + uCamUp * (s.y * uTanHalf.y);
}
/** Distance along the (unnormalized) view ray to the scene, or 1e20 for sky. */
float sceneT(vec2 uv, vec3 ray) {
  float z = texture2D(uDepth, uv).r;
  float t = z <= 0.0 ? 1e20 : z * length(ray); // ray has unit forward component
  if (uSea.w > 0.0) {
    vec3 d = normalize(ray);
    vec3 oc = uCamPos - uSea.xyz;
    float b = dot(oc, d);
    float h = b * b - (dot(oc, oc) - uSea.w * uSea.w);
    if (h > 0.0) {
      float tw = -b - sqrt(h);
      if (tw > 0.0) t = min(t, tw);
    }
  }
  return t;
}
float ign(vec2 px) { return fract(52.9829189 * fract(0.06711056 * px.x + 0.00583715 * px.y)); }
`;

const CLOUD_FRAGMENT = `
precision highp float;
precision highp sampler3D;
varying vec2 vUV;
uniform vec2 uRes;
${CLOUD_UNIFORMS_GLSL}
uniform vec3 uSunColor;
uniform vec3 uAmbientDay;
uniform vec3 uAmbientNight;
uniform vec4 uAtmoR;    // groundR, topR (0 = no air), hR, hM
uniform vec4 uAtmoBeta; // betaR.rgb, betaMExt
uniform float uSteps;
uniform float uLightSteps;
uniform float uShafts;
uniform float uHazeScale;
${CAMERA_GLSL}
${CLOUD_DENSITY_GLSL}
${CLOUD_SHADOW_GLSL}

float hg(float mu, float g) {
  float g2 = g * g;
  return 0.0795775 * (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5);
}

/**
 * The deck along a ray is the top sphere's span minus the base sphere's span:
 * up to two segments (e.g. from inside the deck, looking down past the base,
 * the ray reappears in the deck on the far side of this small planet).
 */
void deckSegments(vec3 o, vec3 d, out vec2 s0, out vec2 s1) {
  s0 = vec2(0.0);
  s1 = vec2(0.0);
  float rb = uPlanetRadius + uCloudBase;
  float rt = rb + uCloudThickness;
  float b = dot(o, d);
  float oo = dot(o, o);
  float h = b * b - (oo - rt * rt);
  if (h < 0.0) return;
  h = sqrt(h);
  float a0 = max(-b - h, 0.0);
  float a1 = -b + h;
  if (a1 <= a0) return;
  float hi = b * b - (oo - rb * rb);
  if (hi <= 0.0) {
    s0 = vec2(a0, a1);
    return;
  }
  hi = sqrt(hi);
  float i0 = -b - hi;
  float i1 = -b + hi;
  if (i0 > a0) s0 = vec2(a0, min(a1, i0));
  if (i1 < a1) {
    vec2 far = vec2(max(a0, i1), a1);
    if (s0.y > s0.x) s1 = far;
    else s0 = far;
  }
}

/**
 * Sunlight reaching body-frame point p: the planet's (slightly soft) shadow
 * times the air it crosses (mirrors sunTransmittance on the CPU).
 */
vec3 sunAt(vec3 p) {
  float gr = uAtmoR.x > 0.0 ? uAtmoR.x : uPlanetRadius;
  float pp = dot(p, p);
  float b = dot(p, uSunLocal);
  // Closest approach of the sun ray to the centre (only if it heads inward).
  float miss = b < 0.0 ? sqrt(max(pp - b * b, 0.0)) : 1e20;
  float w = gr * 0.004;
  float vis = smoothstep(gr - w, gr + w, miss);
  if (vis <= 0.0) return vec3(0.0);
  vec3 tr = vec3(1.0);
  if (uAtmoR.y > 0.0) {
    float rt = uAtmoR.y;
    float ht = b * b - (pp - rt * rt);
    if (ht > 0.0) {
      float t1 = -b + sqrt(ht);
      float t0 = pp > rt * rt ? max(-b - sqrt(ht), 0.0) : 0.0;
      float ds = max(t1 - t0, 0.0) / 6.0;
      float dR = 0.0;
      float dM = 0.0;
      for (int i = 0; i < 6; i++) {
        float h = max(length(p + uSunLocal * (t0 + (float(i) + 0.5) * ds)) - gr, 0.0);
        dR += exp(-h / uAtmoR.z) * ds;
        dM += exp(-h / uAtmoR.w) * ds;
      }
      tr = exp(-(uAtmoBeta.rgb * dR + uAtmoBeta.a * dM));
    }
  }
  return tr * vis;
}

/** Sky light around body-frame point p: day tint, twilight glow, starlight. */
vec3 ambientAt(vec3 p) {
  float el = dot(normalize(p), uSunLocal);
  float day = smoothstep(-0.12, 0.25, el);
  float twilight = smoothstep(0.35, 0.0, abs(el)) * smoothstep(-0.25, -0.05, el);
  float lum = dot(uAmbientDay, vec3(0.3333));
  return mix(uAmbientNight, uAmbientDay, day) + vec3(1.0, 0.6, 0.38) * lum * twilight * 0.35;
}

void marchDeck(vec3 o, vec3 d, vec2 seg, float steps, float phase, float jitter, inout vec3 scatter, inout float T) {
  if (seg.y <= seg.x || steps < 0.5) return;
  float dt = (seg.y - seg.x) / steps;
  float t = seg.x + jitter * dt;
  // Sun and sky light vary slowly across one segment (<= 8 km): evaluate at
  // both ends and interpolate.
  vec3 pA = o + d * seg.x;
  vec3 pB = o + d * seg.y;
  vec3 sunA = uSunColor * sunAt(pA);
  vec3 sunB = uSunColor * sunAt(pB);
  vec3 ambA = ambientAt(pA);
  vec3 ambB = ambientAt(pB);
  for (int i = 0; i < 96; i++) {
    if (float(i) >= steps || T < 0.02) break;
    vec3 p = o + d * t;
    float den = cloudDensity(p);
    if (den > 0.002) {
      // Light march toward the sun through the deck.
      float ld = uCloudThickness / max(uLightSteps, 1.0);
      float od = 0.0;
      for (int j = 0; j < 8; j++) {
        if (float(j) >= uLightSteps) break;
        od += cloudDensity(p + uSunLocal * ld * (float(j) + 0.5)) * ld;
      }
      float lightT = exp(-od * uExtinction) + 0.25 * exp(-od * uExtinction * 0.2);
      float h = clamp((length(p) - uPlanetRadius - uCloudBase) / uCloudThickness, 0.0, 1.0);
      float f = clamp((t - seg.x) / (seg.y - seg.x), 0.0, 1.0);
      vec3 L = mix(sunA, sunB, f) * lightT * phase * 6.0 + mix(ambA, ambB, f) * (0.45 + 0.55 * h);
      float sigma = den * uExtinction;
      float a = 1.0 - exp(-sigma * dt);
      scatter += T * L * a;
      T *= 1.0 - a;
    }
    t += dt;
  }
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 ray = viewRay(vUV);
  vec3 dirW = normalize(ray);
  // Conservative scene distance: farthest of 4 subsamples, so thin foreground
  // edges don't cut holes in the low-res cloud buffer.
  vec2 px = 0.5 / uRes;
  float tScene = max(max(sceneT(vUV + vec2(px.x, px.y), ray), sceneT(vUV + vec2(-px.x, px.y), ray)),
                     max(sceneT(vUV + vec2(px.x, -px.y), ray), sceneT(vUV + vec2(-px.x, -px.y), ray)));
  vec3 o = (uWorldToBody * vec4(uCamPos - uBodyCenter, 0.0)).xyz;
  vec3 d = normalize((uWorldToBody * vec4(dirW, 0.0)).xyz);
  vec3 scatter = vec3(0.0);
  float T = 1.0;
  if (uSteps > 0.5) {
    vec2 s0;
    vec2 s1;
    deckSegments(o, d, s0, s1);
    // Stop at the scene and within 8 km of where the deck starts.
    float tMax = min(tScene, s0.x + 8000.0);
    s0.y = min(s0.y, tMax);
    s1.y = min(s1.y, tMax);
    float l0 = max(s0.y - s0.x, 0.0);
    float l1 = max(s1.y - s1.x, 0.0);
    if (l0 + l1 > 0.0) {
      float n0 = l1 > 0.0 ? max(4.0, floor(uSteps * l0 / (l0 + l1) + 0.5)) : uSteps;
      float n1 = max(uSteps - n0, l1 > 0.0 ? 4.0 : 0.0);
      float mu = dot(d, uSunLocal);
      float phase = mix(hg(mu, 0.6), hg(mu, -0.25), 0.25);
      float jitter = ign(gl_FragCoord.xy);
      marchDeck(o, d, s0, n0, phase, jitter, scatter, T);
      marchDeck(o, d, s1, n1, phase, jitter, scatter, T);
    }
  }
  // Light shafts ("god rays"): haze below the deck lit or shadowed by the
  // clouds. Lit air adds a little, shadowed air takes away, so beams show
  // where sunlight falls through gaps. (Signed: the buffer is float.)
  vec3 shafts = vec3(0.0);
  if (uShafts > 0.5 && uSteps > 0.5) {
    float rb = uPlanetRadius + uCloudBase;
    float tEnd = min(tScene, 3500.0);
    float oo = dot(o, o);
    if (oo < rb * rb) {
      float b = dot(o, d);
      tEnd = min(tEnd, -b + sqrt(max(b * b - (oo - rb * rb), 0.0)));
    }
    // White-noise jitter (not a regular pattern) so the steps read as fine
    // grain rather than rings.
    float ds = tEnd / 24.0;
    float ts = hash12(gl_FragCoord.xy) * ds;
    float acc = 0.0;
    for (int i = 0; i < 24; i++) {
      vec3 p = o + d * ts;
      float h = max(length(p) - uPlanetRadius, 0.0);
      acc += (cloudShadow(p) - ${SHAFT_BIAS.toFixed(3)}) * exp(-h / uHazeScale) * ds;
      ts += ds;
    }
    float mu = dot(d, uSunLocal);
    shafts = uSunColor * sunAt(o) * (hg(mu, 0.76) + 0.08) * acc * ${SHAFT_STRENGTH.toFixed(5)};
    // Seen from above the deck the shafts are behind the clouds.
    if (oo > rb * rb) shafts *= T;
  }
  gl_FragColor = vec4(scatter + shafts, 1.0 - T);
}`;

const COMPOSITE_FRAGMENT = `
precision highp float;
precision highp sampler3D;
varying vec2 vUV;
uniform sampler2D textureSampler; // clouds (premultiplied)
uniform sampler2D uScene;
uniform vec3 uSunDir;
uniform vec3 uSunE;
uniform float uAtmoSteps;
uniform float uCount;
uniform vec3 uCenter[${MAX_ATMO_BODIES}];
uniform vec4 uRadii[${MAX_ATMO_BODIES}];   // groundR, topR, hR, hM
uniform vec4 uBeta[${MAX_ATMO_BODIES}];    // betaR.rgb, betaM
uniform vec2 uMie[${MAX_ATMO_BODIES}];     // betaMExt, g
uniform float uShadowOn;
${CLOUD_UNIFORMS_GLSL}
${CAMERA_GLSL}
${ATMOSPHERE_GLSL}
${CLOUD_DENSITY_GLSL}
${CLOUD_SHADOW_GLSL}

/**
 * The planet's shadow along a ray (origin relative to the centre): the
 * cylinder of radius r behind the planet, away from the sun. Returns the
 * [enter, exit] span, empty (x >= y) when the ray misses it.
 */
vec2 shadowSpan(vec3 o, vec3 d, float r) {
  vec2 none = vec2(1e20, -1e20);
  float os = dot(o, uSunDir);
  float ds = dot(d, uSunDir);
  vec3 op = o - uSunDir * os;
  vec3 dp = d - uSunDir * ds;
  float a = dot(dp, dp);
  float b = dot(op, dp);
  float c = dot(op, op) - r * r;
  vec2 s = vec2(-1e20, 1e20);
  if (a > 1e-8) {
    float h = b * b - a * c;
    if (h < 0.0) return none;
    h = sqrt(h);
    s = vec2((-b - h) / a, (-b + h) / a);
  } else if (c > 0.0) {
    return none;
  }
  // Only the half behind the planet (p . sun < 0).
  if (abs(ds) > 1e-6) {
    float tp = -os / ds;
    if (ds > 0.0) s.y = min(s.y, tp);
    else s.x = max(s.x, tp);
  } else if (os >= 0.0) {
    return none;
  }
  return s;
}

void atmosphere(int k, vec3 camPos, vec3 dir, float tMax, inout vec3 col) {
  vec3 o = camPos - uCenter[k];
  vec4 R = uRadii[k];
  vec2 top = raySphere(o, dir, R.y);
  if (top.x > top.y || top.y <= 0.0) return;
  float t0 = max(top.x, 0.0);
  float t1 = top.y;
  vec2 g = raySphere(o, dir, R.x);
  if (g.x < g.y && g.x > 0.0) t1 = min(t1, g.x);
  t1 = min(t1, tMax);
  if (t1 <= t0) return;
  vec3 betaR = uBeta[k].rgb;
  float betaM = uBeta[k].a;
  float betaMExt = uMie[k].x;
  float mu = dot(dir, uSunDir);
  float pR = phaseRayleigh(mu);
  float pM = phaseMie(mu, uMie[k].y);
  float dt = (t1 - t0) / uAtmoSteps;
  // Where the ray is in the planet's shadow. Each step is weighted by the
  // share of it that is sunlit, so the shadow edge moves smoothly across the
  // sky instead of jumping one whole step at a time (which drew hard arcs).
  vec2 sh = shadowSpan(o, dir, R.x);
  float odR = 0.0;
  float odM = 0.0;
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  for (int i = 0; i < 24; i++) {
    if (float(i) >= uAtmoSteps) break;
    float ta = t0 + float(i) * dt;
    float tb = ta + dt;
    vec3 p = o + dir * (ta + 0.5 * dt);
    float h = max(length(p) - R.x, 0.0);
    float dR = exp(-h / R.z) * dt;
    float dM = exp(-h / R.w) * dt;
    odR += dR;
    odM += dM;
    // Sunlit share of this step, and a lit point in it for the light march.
    float s0 = clamp(sh.x, ta, tb);
    float s1 = clamp(sh.y, ta, tb);
    float lit = 1.0 - max(s1 - s0, 0.0) / dt;
    if (lit <= 1e-3) continue;
    vec3 pl = o + dir * (s0 - ta >= tb - s1 ? 0.5 * (ta + s0) : 0.5 * (s1 + tb));
    if (lit >= 0.999) pl = p;
    vec2 ts = raySphere(pl, uSunDir, R.y);
    float ls = ts.y / 4.0;
    float lR = 0.0;
    float lM = 0.0;
    for (int j = 0; j < 4; j++) {
      float hl = max(length(pl + uSunDir * ls * (float(j) + 0.5)) - R.x, 0.0);
      lR += exp(-hl / R.z) * ls;
      lM += exp(-hl / R.w) * ls;
    }
    vec3 tau = betaR * (odR + lR) + betaMExt * (odM + lM);
    vec3 att = exp(-tau);
    sumR += att * dR * lit;
    sumM += att * dM * lit;
  }
  vec3 inscatter = uSunE * (sumR * betaR * pR + sumM * betaM * pM);
  vec3 trans = exp(-(betaR * odR + betaMExt * odM));
  col = col * trans + inscatter;
}

void main() {
  vec3 ray = viewRay(vUV);
  vec3 dir = normalize(ray);
  float tScene = sceneT(vUV, ray);
  vec3 col = texture2D(uScene, vUV).rgb;
  // Cloud shadows on the ground (and anything else in the depth buffer).
  if (uShadowOn > 0.5 && tScene < 1e19) {
    vec3 pB = (uWorldToBody * vec4(uCamPos + dir * tScene - uBodyCenter, 0.0)).xyz;
    col *= mix(1.0, cloudShadow(pB), ${SHADOW_AMOUNT.toFixed(2)});
  }
  // Clouds sit in front of whatever is behind them (their buffer already
  // stopped at the scene depth).
  vec4 cloud = texture2D(textureSampler, vUV);
  col = max(col * (1.0 - cloud.a) + cloud.rgb, vec3(0.0));
  for (int k = 0; k < ${MAX_ATMO_BODIES}; k++) {
    if (float(k) >= uCount) break;
    atmosphere(k, uCamPos, dir, tScene, col);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export class PlanetaryPass {
  readonly copy: PassPostProcess;
  readonly clouds: PostProcess;
  readonly composite: PostProcess;
  private quality: SkyQuality = "ultra";
  private frame: PlanetaryFrame | null = null;
  private volumeTex: RawTexture3D;
  /** CPU copy of the exact bytes on the GPU (for cloudDensityAt). */
  volume: CloudVolumeData;

  constructor(
    private readonly scene: Scene,
    private readonly camera: Camera,
    private readonly depth: () => Texture,
  ) {
    const engine = scene.getEngine() as Engine;
    Effect.ShadersStore["adriftCloudsFragmentShader"] = CLOUD_FRAGMENT;
    Effect.ShadersStore["adriftCompositeFragmentShader"] = COMPOSITE_FRAGMENT;
    const camUniforms = ["uCamPos", "uCamRight", "uCamUp", "uCamFwd", "uTanHalf", "uSea"];
    const hdr = Constants.TEXTURETYPE_HALF_FLOAT;

    this.volume = new CloudVolumeData(makeVolumeNoiseData(1337));
    this.volumeTex = this.makeVolumeTexture(this.volume);
    void this.loadVolume();

    this.copy = new PassPostProcess(
      "planetary-scene",
      1,
      camera,
      Texture.BILINEAR_SAMPLINGMODE,
      engine,
      false,
      hdr,
    );
    this.clouds = new PostProcess(
      "planetary-clouds",
      "adriftClouds",
      [
        ...camUniforms,
        "uRes",
        "uBodyCenter",
        "uWorldToBody",
        "uPlanetRadius",
        "uCloudBase",
        "uCloudThickness",
        "uCoverage",
        "uExtinction",
        "uWindRate",
        "uEvolve",
        "uTime",
        "uSunLocal",
        "uSunColor",
        "uAmbientDay",
        "uAmbientNight",
        "uAtmoR",
        "uAtmoBeta",
        "uSteps",
        "uLightSteps",
        "uShafts",
        "uHazeScale",
      ],
      ["uDepth", "uCloudVol"],
      CLOUD_SCALE,
      camera,
      Texture.BILINEAR_SAMPLINGMODE,
      engine,
      false,
      null,
      hdr,
    );
    this.composite = new PostProcess(
      "planetary-composite",
      "adriftComposite",
      [
        ...camUniforms,
        "uSunDir",
        "uSunE",
        "uAtmoSteps",
        "uCount",
        "uCenter",
        "uRadii",
        "uBeta",
        "uMie",
        "uShadowOn",
        ...CLOUD_DECK_UNIFORMS,
      ],
      ["uDepth", "uScene", "uCloudVol"],
      1,
      camera,
      Texture.BILINEAR_SAMPLINGMODE,
      engine,
      false,
      null,
      hdr,
    );

    this.clouds.onApply = (e) => {
      this.bindCamera(e);
      const f = this.frame?.clouds;
      const q = QUALITY[this.quality];
      e.setFloat2(
        "uRes",
        this.clouds.width || engine.getRenderWidth(),
        this.clouds.height || engine.getRenderHeight(),
      );
      e.setTexture("uDepth", this.depth());
      e.setTexture("uCloudVol", this.volumeTex);
      e.setFloat("uSteps", f ? q.cloudSteps : 0);
      e.setFloat("uLightSteps", q.lightSteps);
      e.setFloat("uShafts", f && q.shafts ? 1 : 0);
      if (!f) return;
      this.bindCloudDeck(e, f);
      e.setColor3("uSunColor", f.sunColor);
      e.setColor3("uAmbientDay", f.ambientDay);
      e.setColor3("uAmbientNight", f.ambientNight);
      const a = f.atmo;
      if (a) {
        e.setFloat4("uAtmoR", a.groundRadius, a.topRadius, a.hR, a.hM);
        e.setFloat4("uAtmoBeta", a.betaR[0], a.betaR[1], a.betaR[2], a.betaMExt);
      } else {
        e.setFloat4("uAtmoR", 0, 0, 1, 1);
        e.setFloat4("uAtmoBeta", 0, 0, 0, 0);
      }
      e.setFloat("uHazeScale", f.hazeScale);
    };

    const centers = new Float32Array(MAX_ATMO_BODIES * 3);
    const radii = new Float32Array(MAX_ATMO_BODIES * 4);
    const betas = new Float32Array(MAX_ATMO_BODIES * 4);
    const mies = new Float32Array(MAX_ATMO_BODIES * 2);
    this.composite.onApply = (e) => {
      this.bindCamera(e);
      e.setTexture("uDepth", this.depth());
      e.setTextureFromPostProcess("uScene", this.copy);
      e.setTexture("uCloudVol", this.volumeTex);
      const cf = this.frame?.clouds ?? null;
      const shadows = !!cf && QUALITY[this.quality].shadows && QUALITY[this.quality].cloudSteps > 0;
      e.setFloat("uShadowOn", shadows ? 1 : 0);
      if (cf) this.bindCloudDeck(e, cf);
      const f = this.frame;
      const bodies = f?.bodies ?? [];
      const n = Math.min(bodies.length, MAX_ATMO_BODIES);
      for (let k = 0; k < n; k++) {
        const b = bodies[k];
        centers.set([b.center.x, b.center.y, b.center.z], k * 3);
        radii.set([b.params.groundRadius, b.params.topRadius, b.params.hR, b.params.hM], k * 4);
        betas.set([...b.params.betaR, b.params.betaM], k * 4);
        mies.set([b.params.betaMExt, b.params.mieG], k * 2);
      }
      e.setFloat("uCount", n);
      e.setFloat("uAtmoSteps", QUALITY[this.quality].atmoSteps);
      e.setArray3("uCenter", Array.from(centers));
      e.setArray4("uRadii", Array.from(radii));
      e.setArray4("uBeta", Array.from(betas));
      e.setArray2("uMie", Array.from(mies));
      e.setVector3("uSunDir", f?.sunDir ?? Vector3.Up());
      e.setColor3("uSunE", f?.sunIlluminance ?? Color3.Black());
    };
  }

  private bindCloudDeck(e: Effect, f: CloudFrame): void {
    e.setVector3("uBodyCenter", f.center);
    e.setMatrix("uWorldToBody", f.worldToBody);
    e.setFloat("uPlanetRadius", f.params.radius);
    e.setFloat("uCloudBase", f.params.base);
    e.setFloat("uCloudThickness", f.params.thickness);
    e.setFloat("uCoverage", f.params.coverage);
    e.setFloat("uExtinction", f.params.extinction);
    e.setFloat("uWindRate", f.params.windRate);
    e.setFloat("uEvolve", f.params.evolve);
    e.setFloat("uTime", f.time);
    e.setVector3("uSunLocal", f.sunLocal);
  }

  private bindCamera(e: Effect): void {
    const cam = this.camera;
    const m = cam.getWorldMatrix();
    const right = Vector3.TransformNormal(Vector3.Right(), m).normalize();
    const up = Vector3.TransformNormal(Vector3.Up(), m).normalize();
    const fwd = Vector3.TransformNormal(Vector3.Forward(), m).normalize();
    const engine = this.scene.getEngine();
    const aspect = engine.getRenderWidth() / Math.max(1, engine.getRenderHeight());
    const t = Math.tan(cam.fov * 0.5);
    e.setVector3("uCamPos", cam.globalPosition);
    e.setVector3("uCamRight", right);
    e.setVector3("uCamUp", up);
    e.setVector3("uCamFwd", fwd);
    e.setFloat2("uTanHalf", t * aspect, t);
    const sea = this.frame?.sea;
    if (sea) e.setFloat4("uSea", sea.center.x, sea.center.y, sea.center.z, sea.radius);
    else e.setFloat4("uSea", 0, 0, 0, 0);
  }

  private makeVolumeTexture(v: CloudVolumeData): RawTexture3D {
    const tex = new RawTexture3D(
      v.data,
      v.size,
      v.size,
      v.size,
      Constants.TEXTUREFORMAT_RED,
      this.scene,
      false,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
    tex.wrapU = tex.wrapV = tex.wrapR = Texture.WRAP_ADDRESSMODE;
    tex.name = "cloud-volume";
    return tex;
  }

  private async loadVolume(): Promise<void> {
    try {
      const res = await fetch("/textures/clouds/greyNoise3D.bin");
      if (!res.ok) throw new Error(String(res.status));
      const { size, data } = parseShadertoyVolume(await res.arrayBuffer());
      const next = new CloudVolumeData(data, size);
      const tex = this.makeVolumeTexture(next);
      this.volumeTex.dispose();
      this.volumeTex = tex;
      this.volume = next;
    } catch {
      // Keep the procedural volume: CPU and GPU still share the same bytes.
    }
  }

  setQuality(q: SkyQuality): void {
    // Step counts only: the cloud buffer keeps its fixed half resolution
    // (a PostProcess ratio can't be changed after creation).
    this.quality = q;
  }

  update(frame: PlanetaryFrame): void {
    this.frame = frame;
  }
}
