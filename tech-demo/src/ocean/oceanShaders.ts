import { WaveSet, WAVE_GLSL, swashGLSL } from "./oceanWaves";
import { FAST_NOISE_GLSL, OCEAN_MATH_GLSL, SkyPalette, glslNum, skyGLSL } from "../common/shaderChunks";
import { BAKE_MIN, BAKE_RANGE, HEIGHT_BAKE_H, HEIGHT_BAKE_W } from "../terrain/terrainJobs";

/**
 * Ocean ShaderMaterial sources.
 *
 * Everything is computed in the body-fixed frame ("local"): the ocean meshes
 * are children of the body root, the wave field, foam patterns and swash
 * are anchored to the planet's surface (so they don't slide as the planet
 * spins or the floating origin moves), and lighting uses the camera and
 * sun expressed in the same frame. Only the final clip position and the
 * refraction lookup go through the `world` matrix.
 */

export const OCEAN_UNIFORMS = [
  "view",
  "projection",
  "viewProjection",
  "world",
  "uCamLocal",
  "uRadius",
  "uSeaRadius",
  "uSeaLevel",
  "uPatchUp",
  "uPatchT",
  "uPatchB",
  "uPatchOff",
  "uPatchOn",
  "uPatchExtent",
  "uPatchMode",
  "uShoreDetail",
  "uSurfEps",
  "uSurfScale",
  "uWaveAxis",
  "uWaveParam",
  "uWavePhase",
  "uWaveCount",
  "uLodScale",
  "uTime",
  "uShoalGain",
  "uBreakCoef",
  "uRefractAmt",
  "uChopEnable",
  "uGeomFade",
  "uSunDirLocal",
  "uSunTint",
  "uSunIntensity",
  "uSunAmbient",
  "uDeepColor",
  "uShallowColor",
  "uFoamColor",
  "uShallowAlpha",
  "uDepthFade",
  "uFoamAmount",
  "uRippleAmount",
  "uRefraction",
  "uRefrStrength",
  "uSeaValid",
  "uHeightValid",
  "uDebugMode",
  "logarithmicDepthConstant",
];

export const OCEAN_SAMPLERS = ["uHeightMap", "uDepthTex", "uRefrTex"];

const HEIGHT_DECODE = `
vec2 dirToUv(vec3 d) {
  return vec2(atan(d.z, d.x) * 0.15915494 + 0.5, acos(clamp(d.y, -1.0, 1.0)) * 0.31830989);
}
const vec2 HEIGHT_SIZE = vec2(${glslNum(HEIGHT_BAKE_W)}, ${glslNum(HEIGHT_BAKE_H)});
float heightTexel(vec2 ij) {
  vec4 t = texture2D(uHeightMap, (ij + 0.5) / HEIGHT_SIZE);
  return (t.r * 255.0 * 256.0 + t.g * 255.0) / 65535.0;
}
/**
 * Terrain height (m above the mean radius) under a unit direction. The map
 * is sampled NEAREST and interpolated here: hardware bilinear on the packed
 * R/G bytes produced metre-scale spikes wherever the low byte wrapped, which
 * made the waterline jagged.
 */
float terrainHeightAt(vec3 d) {
  vec2 st = dirToUv(d) * HEIGHT_SIZE - 0.5;
  vec2 i0 = floor(st);
  vec2 f = st - i0;
  float h00 = heightTexel(i0);
  float h10 = heightTexel(i0 + vec2(1.0, 0.0));
  float h01 = heightTexel(i0 + vec2(0.0, 1.0));
  float h11 = heightTexel(i0 + vec2(1.0, 1.0));
  float q = mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
  return q * ${glslNum(BAKE_RANGE)} + ${glslNum(BAKE_MIN)};
}`;

/** Vertex shader: Gerstner displacement + run-up + land cap (local frame). */
export function buildOceanVertexSource(waveSet: WaveSet, patchBias: number): string {
  return `
precision highp float;
attribute vec3 position;
uniform mat4 view;
uniform mat4 viewProjection;
uniform mat4 world;
uniform vec3 uCamLocal;
uniform float uRadius;
uniform float uSeaRadius;
uniform float uSeaLevel;
uniform vec3 uPatchUp;
uniform vec3 uPatchT;
uniform vec3 uPatchB;
uniform vec2 uPatchOff;
uniform float uPatchMode;
uniform sampler2D uHeightMap;
uniform float uHeightValid;
uniform float uShoreDetail;
uniform float uSurfEps;

#include<logDepthDeclaration>

${WAVE_GLSL}
${swashGLSL(waveSet.swash)}
${HEIGHT_DECODE}

varying vec3 vLocalPos;
varying vec3 vNormalL;
varying float vDepth;
varying vec3 vTanA;
varying vec3 vTanB;
varying float vBreaking;
varying float vWaveHeight;
varying float vEyeDepth;
varying vec4 vClip;

void main() {
  vec3 n;
  vec3 tA;
  vec3 tB;
  if (uPatchMode > 0.5) {
    // Grid positions + a whole-cell offset in a fixed anchor plane: the
    // lattice only ever jumps by one centre cell, and never rotates.
    vec2 gp = position.xz + uPatchOff;
    n = normalize(uPatchUp * uSeaRadius + uPatchT * gp.x + uPatchB * gp.y);
    tA = uPatchT - n * dot(uPatchT, n);
    tA = length(tA) > 1e-4 ? normalize(tA) : normalize(cross(n, vec3(0.0, 1.0, 0.0)));
  } else {
    n = normalize(position);
    vec3 ref = abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    tA = normalize(cross(ref, n));
  }
  tB = cross(n, tA);

  vec3 approx = n * uSeaRadius;
  float dist = length(uCamLocal - approx);

  // Water depth + shore direction from the baked terrain height map.
  float h0 = uHeightValid > 0.5 ? terrainHeightAt(n) : uSeaLevel - 100.0;
  float depth = uSeaLevel - h0;
  vec3 shoreDir = tA;
  if (uShoreDetail > 0.5 && uHeightValid > 0.5 && depth < uSurfScale.x) {
    vec3 nT = normalize(n + tA * (uSurfEps / uRadius));
    vec3 nB = normalize(n + tB * (uSurfEps / uRadius));
    float dT = uSeaLevel - terrainHeightAt(nT);
    float dB = uSeaLevel - terrainHeightAt(nB);
    vec3 grad = tA * ((dT - depth) / uSurfEps) + tB * ((dB - depth) / uSurfEps);
    float gl2 = dot(grad, grad);
    if (gl2 > 1e-8) shoreDir = -grad * inversesqrt(gl2);
  }

  float dispRad;
  vec3 dispTan;
  vec3 waveNrm;
  float breaking;
  oceanWaveSum(approx, n, dist, depth, shoreDir, tA, tB, dispRad, dispTan, waveNrm, breaking);

  float shallow = clamp(1.0 - depth / 6.0, 0.0, 1.0);
  float rise = swashRise(approx, uTime, shallow);
  float slopeT;
  float slopeB;
  swashSlope(approx, uTime, shallow, tA, tB, slopeT, slopeB);

  float radial;
  vec3 tangent;
  if (uPatchMode < 0.5) {
    // Shell: only the slow run-up shapes the geometry; the rest is shading.
    radial = rise;
    tangent = vec3(0.0);
    // Far field only (the patch covers the near shore): keep the coarse
    // shell from riding up over low land.
    float landAbove = max(h0 - uSeaLevel, 0.0);
    if (landAbove > 0.0) radial = min(radial, max(landAbove - 0.5, 0.0));
  } else {
    // Patch. Near the shore the surface is only sea level + the run-up:
    // both are smooth (the run-up wavelengths are tens of metres), so the
    // waterline -- where this surface meets the rendered ground -- no longer
    // depends on where the (camera-following) vertices happen to sit. The
    // Gerstner waves, their sideways motion and the anti-z-fight bias fade
    // out over the last ~2 m of depth. This replaces the old per-vertex
    // "never above land" clamp, which cut the run-up off along a
    // vertex-sampled contour and shimmered whenever the grid moved.
    float shoreCalm = smoothstep(0.0, 2.0, depth);
    radial = (dispRad + ${glslNum(patchBias)}) * shoreCalm + rise * mix(1.0, 0.5, shoreCalm);
    tangent = dispTan * shoreCalm;
  }
  vec3 nrm = normalize(waveNrm - tA * slopeT - tB * slopeB);

  vec3 lp = n * (uSeaRadius + radial) + tangent;
  vLocalPos = lp;
  vNormalL = nrm;
  vDepth = depth;
  vTanA = tA;
  vTanB = tB;
  vBreaking = breaking;
  vWaveHeight = dispRad;
  vec4 wp = world * vec4(lp, 1.0);
  vEyeDepth = (view * wp).z;
  gl_Position = viewProjection * wp;
  vClip = gl_Position;
  #include<logDepthVertex>
}`;
}

/** Fragment shader: depth colour, sky reflection, foam, refraction (local frame). */
export function buildOceanFragmentSource(sky: SkyPalette, waveSet: WaveSet): string {
  return `
precision highp float;
varying vec3 vLocalPos;
varying vec3 vNormalL;
varying float vDepth;
varying vec3 vTanA;
varying vec3 vTanB;
varying float vBreaking;
varying float vWaveHeight;
varying float vEyeDepth;
varying vec4 vClip;
uniform float uPatchMode;
uniform float uPatchOn;
uniform float uPatchExtent;
uniform float uSeaRadius;
uniform vec3 uPatchUp;
uniform vec3 uPatchT;
uniform vec3 uPatchB;
uniform vec2 uPatchOff;

uniform mat4 viewProjection;
uniform mat4 world;
uniform vec3 uCamLocal;
uniform vec3 uSunDirLocal;
uniform vec3 uSunTint;
uniform float uSunIntensity;
uniform float uSunAmbient;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uFoamColor;
uniform float uShallowAlpha;
uniform float uDepthFade;
uniform float uFoamAmount;
uniform float uRippleAmount;
uniform float uRefraction;
uniform float uRefrStrength;
uniform float uShoreDetail;
uniform float uSeaValid;
uniform float uTime;
uniform float uDebugMode;
uniform sampler2D uDepthTex;
uniform sampler2D uRefrTex;
uniform vec3 uSurfScale;

#include<logDepthDeclaration>

${OCEAN_MATH_GLSL}
${FAST_NOISE_GLSL}
${skyGLSL(sky)}
${swashGLSL(waveSet.swash)}

float foamPattern(vec3 p, float t) {
  float a = waterFbm(p * 2.6 + vec3(0.0, t * 0.35, t * 0.12), 2);
  float b = waterFbm(p * 6.0 - vec3(t * 0.22, 0.0, t * 0.31), 2);
  return smoothstep(0.3, 0.95, a * 0.62 + b * 0.5);
}

/** Scene depth (camera-space z) behind this pixel; huge where nothing was drawn. */
float sceneDepthAt(vec2 uv) {
  float z = texture2D(uDepthTex, uv).r;
  return z > 0.0 ? z : 1.0e9;
}

void main() {
  #include<logDepthFragment>
  // Coarse cull only: the height map is ~6 m per texel and the patch vertices
  // slide as the camera moves, so a tight vDepth test cut the waterline along
  // triangle edges that flickered. The visible waterline is where the water
  // plane meets the rendered ground (depth test + the contact fade below).
  if (vDepth < -3.0) discard;
  // The coarse shell (vertices tens of metres apart) must not show through
  // where the fine patch covers: its own run-up facets made a second,
  // jagged waterline at the beach.
  if (uPatchMode < 0.5 && uPatchOn > 0.5) {
    vec3 sd = normalize(vLocalPos);
    float sc = dot(sd, uPatchUp);
    if (sc > 0.0) {
      vec3 sp = sd * (uSeaRadius / sc);
      vec2 g = vec2(dot(sp, uPatchT), dot(sp, uPatchB)) - uPatchOff;
      if (max(abs(g.x), abs(g.y)) < uPatchExtent - 12.0) discard;
    }
  }

  vec3 up = normalize(vLocalPos);
  vec3 V = normalize(uCamLocal - vLocalPos);
  vec3 sunToward = -uSunDirLocal;
  vec3 n = normalize(vNormalL);
  float dist = length(uCamLocal - vLocalPos);

  if (uDebugMode > 0.5) {
    if (uDebugMode < 1.5) gl_FragColor = vec4(vec3(clamp(vDepth / 8.0, 0.0, 1.0)), 1.0);
    else if (uDebugMode < 2.5) gl_FragColor = vec4(vec3(vBreaking), 1.0);
    else gl_FragColor = vec4(vec3(length(n - up * dot(n, up)) * 3.0), 1.0);
    return;
  }

  float rippleW = uRippleAmount * (1.0 - smoothstep(40.0, 190.0, dist));
  if (rippleW > 0.01) {
    vec3 p = vLocalPos;
    float e = 0.6;
    vec3 drift = vec3(uTime * 0.5, 0.0, uTime * 0.3);
    float h0 = waterFbm(p * 0.42 + drift, 1);
    float hx = waterFbm(p * 0.42 + vTanA * (e * 0.42) + drift, 1);
    float hy = waterFbm(p * 0.42 + vTanB * (e * 0.42) + drift, 1);
    vec3 tilt = vTanA * ((hx - h0) / e) + vTanB * ((hy - h0) / e);
    n = normalize(n - tilt * rippleW * 2.2);
  }

  float depthT = clamp(vDepth / max(uDepthFade, 0.5), 0.0, 1.0);
  float deepMix = smoothstep(0.04, 1.0, depthT);
  vec3 body = mix(uShallowColor, uDeepColor, deepMix);

  vec3 H = normalize(V + sunToward);
  float crestT = clamp((vWaveHeight - 0.02) / 0.45, 0.0, 1.0);
  float sss = pow(max(dot(V, -H), 0.0), 6.0) * 1.1 * crestT;
  body += vec3(0.154, 0.886, 0.99) * sss;

  float ndv = max(dot(n, V), 0.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, n);
  vec3 skyCol = skyColor(R, up, sunToward) * max(uSunAmbient, 0.02);
  float gloss = mix(0.62, 0.93, 1.0 / (1.0 + dist * 0.004));
  float specPow = exp2(4.0 + 10.0 * gloss);
  float spec = pow(max(dot(n, H), 0.0), specPow) * (0.4 + 0.6 * gloss);
  vec3 surfaceCol = mix(body, skyCol, clamp(fresnel * 1.15, 0.0, 0.92));
  surfaceCol += uSunTint * (spec * uSunIntensity * 0.55);
  surfaceCol *= max(uSunAmbient, 0.05);

  vec2 sUv = clamp(vClip.xy / vClip.w * 0.5 + 0.5, 0.001, 0.999);
  // Water in front of the ground behind this pixel (camera-space z), per pixel.
  float sheet = uSeaValid > 0.5 ? max(sceneDepthAt(sUv) - vEyeDepth, 0.0) : 1.0e9;
  float foam = 0.0;
  if (uFoamAmount > 0.01) {
    float pattern = foamPattern(vLocalPos, uTime);
    float shallowC = clamp(1.0 - vDepth / 6.0, 0.0, 1.0);
    float ph = swashPhaseA(vLocalPos, uTime, shallowC);
    float arriving = smoothstep(-0.35, 0.85, sin(ph));
    float tilt = length(n - up * dot(n, up));
    float whitecap = smoothstep(0.5, 1.0, tilt) * smoothstep(0.6, 1.0, pattern);
    float surf = smoothstep(0.35, 0.85, vBreaking) * smoothstep(0.55, 1.0, pattern)
               * (0.15 + 0.85 * arriving) * 0.85;
    foam = max(whitecap, surf) * 0.8 * uFoamAmount;

    if (uShoreDetail > 0.5 && uSeaValid > 0.5) {
      float contact = 1.0 - smoothstep(0.12, 1.1, sheet);
      float dRun = cos(ph);
      float lace = smoothstep(0.25, -0.65, dRun) * (0.4 + 0.6 * pattern);
      float shallowBand = 1.0 - smoothstep(0.25, 1.3, vDepth);
      float shoreBand = ((0.2 + 0.5 * arriving) * contact + lace * contact) * shallowBand;
      foam = max(foam, clamp(shoreBand, 0.0, 1.0) * 0.7 * uFoamAmount);
    }
  }
  foam = clamp(foam, 0.0, 1.0);
  surfaceCol = mix(surfaceCol, uFoamColor * max(uSunAmbient, 0.05), foam);

  // Opacity follows the light path through the water along the view ray
  // (vertical depth / cos of the viewing angle), not the vertical depth
  // alone: at a glancing angle even shallow water is opaque, so distant
  // shallows no longer show the sea floor like glass.
  float viewCos = max(dot(up, V), 0.03);
  float viewPathT = clamp(vDepth / viewCos / max(uDepthFade, 0.5), 0.0, 1.0);
  float alpha = mix(uShallowAlpha, 1.0, smoothstep(0.04, 1.0, max(viewPathT, deepMix)));
  alpha = max(alpha, fresnel * (1.0 - foam));
  alpha = max(alpha, foam);

  vec3 finalCol = surfaceCol;
  float finalAlpha = alpha;
  if (uRefraction > 0.5 && uSeaValid > 0.5) {
    float path = sheet;
    if (path < 200.0) {
      vec3 rDir = refract(-V, n, 0.75);
      float travel = path / max(dot(rDir, -V), 0.25);
      vec4 pc = viewProjection * (world * vec4(vLocalPos + rDir * travel, 1.0));
      vec2 rUv = clamp(pc.xy / max(pc.w, 1e-4) * 0.5 + 0.5, 0.001, 0.999);
      vec3 sample_ = texture2D(uRefrTex, rUv).rgb;
      vec3 absorb = exp(-vec3(0.55, 0.22, 0.14) * path / max(uDepthFade, 0.5));
      vec3 through = sample_ * absorb + uDeepColor * max(uSunAmbient, 0.05) * (1.0 - absorb);
      vec3 composited = mix(through, surfaceCol, clamp(alpha * 0.85 + fresnel * 0.4, 0.0, 1.0));
      finalCol = mix(surfaceCol, composited, uRefrStrength);
      finalAlpha = 1.0;
    }
  }

  // Soft, pixel-accurate waterline: fade the last few centimetres of water
  // over the ground instead of a hard polygon edge.
  if (uSeaValid > 0.5) finalAlpha *= smoothstep(0.0, 0.3, sheet);

  gl_FragColor = vec4(finalCol, finalAlpha);
  if (finalAlpha < 0.01) discard;
}`;
}
