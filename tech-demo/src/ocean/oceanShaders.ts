import { WaveSet, WAVE_GLSL, swashGLSL } from "./oceanWaves";
import { FAST_NOISE_GLSL, OCEAN_MATH_GLSL, SkyPalette, glslNum, skyGLSL } from "../common/shaderChunks";

/**
 * Ocean ShaderMaterial sources (SRP: shader text lives here, mesh + frame
 * state lives in ocean.ts). Extracted verbatim from createOcean so the
 * compiled shaders are byte-identical; only the patch z-fighting bias and
 * the sky palette / swash set vary per planet.
 */

/** Uniform + sampler names shared by the shell and patch materials. */
export const OCEAN_UNIFORMS = [
  "view",
  "projection",
  "viewProjection",
  "world",
  "cameraPosition",
  "uPlanetCenter",
  "uRadius",
  "uSeaRadius",
  "uRelief",
  "uWaterLevel",
  "uPatchUp",
  "uPatchT",
  "uPatchB",
  "uPatchMode",
  "uHeightMap",
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
  "uSunDir",
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
  "uDepthTex",
  "uRefrTex",
  "uCameraData",
  "uDebugMode",
];

/** Sampler names for the ocean materials. */
export const OCEAN_SAMPLERS = ["uHeightMap", "uDepthTex", "uRefrTex"];

/** Vertex shader: Gerstner displacement + run-up + land cap. */
export function buildOceanVertexSource(waveSet: WaveSet, patchBias: number): string {
  return `
precision highp float;
attribute vec3 position;
uniform mat4 view;
uniform mat4 viewProjection;
uniform mat4 world;
uniform vec3 cameraPosition;
uniform vec3 uPlanetCenter;
uniform float uRadius;
uniform float uSeaRadius;
uniform float uRelief;
uniform float uWaterLevel;
uniform vec3 uPatchUp;
uniform vec3 uPatchT;
uniform vec3 uPatchB;
uniform float uPatchMode;
uniform sampler2D uHeightMap;
uniform float uShoreDetail;
uniform float uSurfEps;

${WAVE_GLSL}
${swashGLSL(waveSet.swash)}

varying vec3 vWorldPos;
varying vec3 vNormalW;
varying float vDepth;
varying vec3 vShoreDir;
varying vec3 vTanA;
varying vec3 vTanB;
varying float vBreaking;
varying float vWaveHeight;
varying float vEyeDepth;
varying vec4 vClip;

vec2 dirToUv(vec3 d) {
  return vec2(atan(d.z, d.x) * 0.15915494 + 0.5, acos(clamp(d.y, -1.0, 1.0)) * 0.31830989);
}
float terrainHeightAt(vec3 d) {
  vec2 uv = dirToUv(d);
  vec4 t = texture2D(uHeightMap, uv);
  float u = (t.r * 255.0 * 256.0 + t.g * 255.0) / 65535.0;
  return u * 3.0 - 1.5;
}

void main() {
  vec3 n;
  vec3 tA;
  vec3 tB;
  if (uPatchMode > 0.5) {
    n = normalize(uPatchUp * uRadius + uPatchT * position.x + uPatchB * position.z);
    tA = uPatchT - n * dot(uPatchT, n);
    tA = length(tA) > 1e-4 ? normalize(tA) : normalize(cross(n, vec3(0.0, 1.0, 0.0)));
  } else {
    n = normalize(position);
    vec3 ref = abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    tA = normalize(cross(ref, n));
  }
  tB = cross(n, tA);

  vec3 worldApprox = uPlanetCenter + n * uSeaRadius;
  float dist = length(cameraPosition - worldApprox);

  // Terrain depth + shore direction from the baked height field.
  float h0 = terrainHeightAt(n);
  float depth = (uWaterLevel - h0) * uRelief * uRadius;
  vec3 shoreDir = tA;
  if (uShoreDetail > 0.5 && depth < uSurfScale.x) {
    vec3 nT = normalize(n + tA * (uSurfEps / uRadius));
    vec3 nB = normalize(n + tB * (uSurfEps / uRadius));
    float dT = (uWaterLevel - terrainHeightAt(nT)) * uRelief * uRadius;
    float dB = (uWaterLevel - terrainHeightAt(nB)) * uRelief * uRadius;
    vec3 grad = tA * ((dT - depth) / uSurfEps) + tB * ((dB - depth) / uSurfEps);
    float gl2 = dot(grad, grad);
    if (gl2 > 1e-8) shoreDir = -grad * inversesqrt(gl2);
  }

  float dispRad;
  vec3 dispTan;
  vec3 waveNrm;
  float breaking;
  oceanWaveSum(worldApprox, n, dist, depth, shoreDir, tA, tB, dispRad, dispTan, waveNrm, breaking);

  float shallow = clamp(1.0 - depth / 6.0, 0.0, 1.0);
  float rise = swashRise(worldApprox, uTime, shallow);
  float slopeT;
  float slopeB;
  swashSlope(worldApprox, uTime, shallow, tA, tB, slopeT, slopeB);

  float radial = dispRad + rise;
  vec3 tangent = dispTan;
  if (uPatchMode < 0.5) {
    // Shell: only the slow run-up shapes the geometry; the rest is shading only.
    radial = rise;
    tangent = vec3(0.0);
  } else {
    // Patch: the run-up sheet is damped back (coarse grid -> visible facets) — the
    // wet-sand band and per-fragment swash keep the animation readable.
    radial = dispRad + rise * 0.5;
    radial += ${glslNum(patchBias)}; // bias over the shell: no z-fighting at the rim
  }
  // Never let the water surface ride above the land. Where the baked terrain
  // stands above the still waterline, the run-up (and the patch's z-fighting
  // bias) are capped just under the ground, so neither can sheet foam across
  // flat coastal ground. The cap uses the same height field as the ground mesh,
  // so it only bites where the terrain is genuinely above the water.
  float landAbove = max((h0 - uWaterLevel) * uRelief * uRadius, 0.0);
  if (landAbove > 0.0) {
    radial = min(radial, max(landAbove - 0.5, 0.0));
  }
  vec3 nrm = normalize(waveNrm - tA * slopeT - tB * slopeB);

  vec3 wp = uPlanetCenter + n * (uSeaRadius + radial) + tangent;

  vWorldPos = wp;
  vNormalW = nrm;
  vDepth = depth;
  vShoreDir = shoreDir;
  vTanA = tA;
  vTanB = tB;
  vBreaking = breaking;
  vWaveHeight = dispRad;
  vec4 viewPos = view * vec4(wp, 1.0);
  vEyeDepth = -viewPos.z;
  gl_Position = viewProjection * vec4(wp, 1.0);
  vClip = gl_Position;
}`;
}

/** Fragment shader: depth colour, sky reflection, foam, refraction. */
export function buildOceanFragmentSource(sky: SkyPalette, waveSet: WaveSet): string {
  return `
precision highp float;
varying vec3 vWorldPos;
varying vec3 vNormalW;
varying float vDepth;
varying vec3 vShoreDir;
varying vec3 vTanA;
varying vec3 vTanB;
varying float vBreaking;
varying float vWaveHeight;
varying float vEyeDepth;
varying vec4 vClip;

uniform mat4 view;
uniform mat4 projection;
uniform vec3 cameraPosition;
uniform vec3 uPlanetCenter;
uniform vec3 uSunDir;
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
uniform vec4 uCameraData;   // x = minZ, y = maxZ, z = maxZ - minZ
uniform vec3 uSurfScale;

${OCEAN_MATH_GLSL}
${FAST_NOISE_GLSL}
${skyGLSL(sky)}
${swashGLSL(waveSet.swash)}

/** Foam breakup pattern (procedural): two scrolling octaves, crisp sub-metre scale. */
float foamPattern(vec3 p, float t) {
  float a = waterFbm(p * 2.6 + vec3(0.0, t * 0.35, t * 0.12), 2);
  float b = waterFbm(p * 6.0 - vec3(t * 0.22, 0.0, t * 0.31), 2);
  return smoothstep(0.3, 0.95, a * 0.62 + b * 0.5);
}

void main() {
  // Never draw the sheet over land. The baked height field (the same field the
  // ground mesh is displaced by) says how far the terrain stands above the
  // still water; near the surface the depth buffer cannot resolve a sub-metre
  // gap, so without this the translucent water leaks through low coastal ground
  // and drags its foam with it. A small tolerance leaves the true waterline to
  // the depth test.
  if (vDepth < -0.05) discard;

  vec3 up = normalize(vWorldPos - uPlanetCenter);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 sunToward = -uSunDir;
  vec3 n = normalize(vNormalW);

  float dist = length(cameraPosition - vWorldPos);

  // Debug views (uDebugMode): 1 = depth, 2 = breaking, 3 = wave slope.
  if (uDebugMode > 0.5) {
    if (uDebugMode < 1.5) {
      gl_FragColor = vec4(vec3(clamp(vDepth / 8.0, 0.0, 1.0)), 1.0);
    } else if (uDebugMode < 2.5) {
      gl_FragColor = vec4(vec3(vBreaking), 1.0);
    } else {
      gl_FragColor = vec4(vec3(length(n - up * dot(n, up)) * 3.0), 1.0);
    }
    return;
  }

  // --- Sub-pixel ripple detail (procedural normals; fades with distance). ---
  float rippleW = uRippleAmount * (1.0 - smoothstep(40.0, 190.0, dist));
  if (rippleW > 0.01) {
    vec3 p = vWorldPos;
    float e = 0.6;
    float h0 = waterFbm(p * 0.42 + vec3(uTime * 0.5, 0.0, uTime * 0.3), 1);
    float hx = waterFbm(p * 0.42 + vTanA * (e * 0.42) + vec3(uTime * 0.5, 0.0, uTime * 0.3), 1);
    float hy = waterFbm(p * 0.42 + vTanB * (e * 0.42) + vec3(uTime * 0.5, 0.0, uTime * 0.3), 1);
    vec3 tilt = (vTanA * ((hx - h0) / e) + vTanB * ((hy - h0) / e));
    n = normalize(n - tilt * rippleW * 2.2);
  }

  // --- Depth colour + transmission. ---
  float depthT = clamp(vDepth / max(uDepthFade, 0.5), 0.0, 1.0);
  float deepMix = smoothstep(0.04, 1.0, depthT);
  vec3 body = mix(uShallowColor, uDeepColor, deepMix);

  // Sub-surface glow on crests (reference demo's SSS term, scaled to a small world).
  vec3 H = normalize(V + sunToward);
  float crestT = clamp((vWaveHeight - 0.02) / 0.45, 0.0, 1.0);
  float sss = pow(max(dot(V, -H), 0.0), 6.0) * 1.1 * crestT;
  body += vec3(0.154, 0.886, 0.99) * sss;

  // --- Fresnel sky reflection + sun glitter. ---
  float ndv = max(dot(n, V), 0.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, n);
  vec3 sky = skyColor(R, up, sunToward) * max(uSunAmbient, 0.02);
  float gloss = mix(0.62, 0.93, 1.0 / (1.0 + dist * 0.004));
  float specPow = exp2(4.0 + 10.0 * gloss);
  float spec = pow(max(dot(n, H), 0.0), specPow) * (0.4 + 0.6 * gloss);
  vec3 surfaceCol = mix(body, sky, clamp(fresnel * 1.15, 0.0, 0.92));
  surfaceCol += uSunTint * (spec * uSunIntensity * 0.55);

  // --- Foam: whitecaps, surf whitewater, waterline sheet, receding lace. ---
  float foam = 0.0;
  if (uFoamAmount > 0.01) {
    float pattern = foamPattern(vWorldPos, uTime);
    float shallowC = clamp(1.0 - vDepth / 6.0, 0.0, 1.0);
    float ph = swashPhaseA(vWorldPos, uTime, shallowC);
    float arriving = smoothstep(-0.35, 0.85, sin(ph));
    // Deep-water whitecaps on steep crests.
    float tilt = length(n - up * dot(n, up));
    float whitecap = smoothstep(0.5, 1.0, tilt) * smoothstep(0.6, 1.0, pattern);
    // Surf: whitewater where the shoaling model clipped the wave height, pulsed by
    // the swash so breakers arrive in sets instead of a uniform white field.
    float surf = smoothstep(0.35, 0.85, vBreaking) * smoothstep(0.55, 1.0, pattern)
               * (0.15 + 0.85 * arriving) * 0.85;
    foam = max(whitecap, surf) * 0.8 * uFoamAmount;

    if (uShoreDetail > 0.5 && uSeaValid > 0.5) {
      // Exact waterline from the depth buffer: foam only where the water is a thin
      // sheet over the terrain, so a wide shallow shelf does not go solid white.
      vec2 sUv = clamp(vClip.xy / vClip.w * 0.5 + 0.5, 0.001, 0.999);
      float bgDepth = uCameraData.x + texture2D(uDepthTex, sUv).r * uCameraData.z;
      float sheet = max(bgDepth - vEyeDepth, 0.0);
      float contact = 1.0 - smoothstep(0.12, 1.1, sheet);
      // Run-up: stronger foam as the swash arrives, a fading lace as it recedes.
      float dRun = cos(ph);
      float lace = smoothstep(0.25, -0.65, dRun) * (0.4 + 0.6 * pattern);
      // Keep the foam hugging the waterline: only genuinely shallow water foams.
      float shallowBand = 1.0 - smoothstep(0.25, 1.3, vDepth);
      float shoreBand = ((0.2 + 0.5 * arriving) * contact + lace * contact) * shallowBand;
      foam = max(foam, clamp(shoreBand, 0.0, 1.0) * 0.7 * uFoamAmount);
    }
  }
  foam = clamp(foam, 0.0, 1.0);
  surfaceCol = mix(surfaceCol, uFoamColor, foam);

  // --- Alpha: transparent shallows, opaque deep/grazing, opaque foam. ---
  float alpha = mix(uShallowAlpha, 1.0, deepMix);
  alpha = max(alpha, fresnel * (1.0 - foam));
  alpha = max(alpha, foam);

  // --- Refraction composite (transmission through the distorted surface). ---
  vec3 finalCol = surfaceCol;
  float finalAlpha = alpha;
  if (uRefraction > 0.5 && uSeaValid > 0.5 && vDepth > 0.02) {
    vec2 sUv2 = clamp(vClip.xy / vClip.w * 0.5 + 0.5, 0.001, 0.999);
    float bgDepth = uCameraData.x + texture2D(uDepthTex, sUv2).r * uCameraData.z;
    float path = max(bgDepth - vEyeDepth, 0.0);
    if (path < uCameraData.z * 0.9) {
      vec3 rDir = refract(-V, n, 0.75);
      float travel = path / max(dot(rDir, -V), 0.25);
      vec4 pc = projection * view * vec4(vWorldPos + rDir * travel, 1.0);
      vec2 rUv = clamp(pc.xy / max(pc.w, 1e-4) * 0.5 + 0.5, 0.001, 0.999);
      vec3 sample_ = texture2D(uRefrTex, rUv).rgb;
      vec3 absorb = exp(-vec3(0.55, 0.22, 0.14) * path / max(uDepthFade, 0.5));
      vec3 through = sample_ * absorb + uDeepColor * (1.0 - absorb);
      vec3 composited = mix(through, surfaceCol, clamp(alpha * 0.85 + fresnel * 0.4, 0.0, 1.0));
      finalCol = mix(surfaceCol, composited, uRefrStrength);
      finalAlpha = 1.0;
    }
  }

  gl_FragColor = vec4(finalCol, finalAlpha);
  if (finalAlpha < 0.01) discard;
}`;
}
