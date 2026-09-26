import {
  Scene, Mesh, VertexData, Vector2, Vector3, Vector4, Color3, Color4, ShaderMaterial,
  Texture, RenderTargetTexture,
} from "@babylonjs/core";
import type { DepthRenderer } from "@babylonjs/core";
import {
  WaveSet, WaveSettings, buildWaveSet, cpuWaveHeightAt, WAVE_GLSL, swashGLSL,
  MAX_WAVES,
} from "./oceanWaves";
import { FAST_NOISE_GLSL, OCEAN_MATH_GLSL, SkyPalette, glslNum, skyGLSL } from "./shaderChunks";

/**
 * Two-layer procedural ocean for a spherical planet (see docs/tech-demo.md):
 *
 *  - `shell`: a sphere at mean sea level, always on (the orbital/interplanetary
 *    view). Fragment-shaded waves, no vertex displacement beyond the slow
 *    run-up swell (its tessellation cannot resolve wind waves).
 *  - `patch`: a camera-following warped disc (dense near the camera) that
 *    carries the real Gerstner geometry, the surf zone (shoaling, refraction,
 *    breaking foam) and the run-up.
 *
 * Depth + shore direction come from a baked terrain height texture (see
 * `bakeTerrainHeightTexture` in planetSurface.ts) so the shader cheaply knows
 * where the coast is; the exact waterline comes from the depth buffer, and the
 * refraction composite samples a half-res colour target of the ground.
 */

export interface OceanOptions {
  radius: number;
  relief: number;
  waterLevel: number;
  seed: number;
  /** Shell segments (match the ground mesh so their rims agree). */
  segments: number;
  /** Height field of the SHAPED terrain (see bakeTerrainHeightTexture). */
  heightMap: Texture;
  /** Ground mesh: source for the depth + refraction render targets. */
  ground: Mesh;
  waves: WaveSettings;
  sky: SkyPalette;
  shallowColor: Color3;
  deepColor: Color3;
  foamColor: Color3;
  /** Alpha of the water right at the shore (deep water is opaque). */
  shallowAlpha: number;
  /** Depth (world units) over which shallow water turns deep. */
  depthFade: number;
}

export interface OceanResult {
  shell: Mesh;
  patch: Mesh;
  /** @param isHost true for the body the ship/camera is closest to. */
  update: (dt: number, sunDir: Vector3, isHost: boolean) => void;
  setQuality: (high: boolean) => void;
  /** Water surface radius (from the planet centre) at a surface point. */
  waterRadiusAt: (dir: Vector3) => number;
  /** Accumulated simulation time (same clock the shaders use). */
  elapsed: () => number;
  stats: () => { shellVerts: number; patchVerts: number; waveCount: number; time: number };
  waveSet: WaveSet;
}

const PATCH_HALF = 48;   // grid cells per side (97 x 97 vertices)
const PATCH_D = 240;     // patch radius on the surface, world units
const PATCH_POWER = 1.55;
const PATCH_BIAS = 0.12; // radial bias over the shell: kills z-fighting at the rim
const PATCH_MAX_ALT = 650;

/** Shared per-scene GPU helpers: two planets share one depth + refraction pair. */
interface OceanShared {
  depth: DepthRenderer;
  refr: RenderTargetTexture;
}
const SHARED = new WeakMap<Scene, OceanShared>();

function getShared(scene: Scene): OceanShared {
  let shared = SHARED.get(scene);
  if (!shared) {
    const depth = scene.enableDepthRenderer();
    const engine = scene.getEngine();
    const size = (): { width: number; height: number } => ({
      width: Math.max(256, Math.floor(engine.getRenderWidth() / 2)),
      height: Math.max(128, Math.floor(engine.getRenderHeight() / 2)),
    });
    const refr = new RenderTargetTexture("ocean-refr", size(), scene, false);
    refr.clearColor = new Color4(0, 0, 0, 0);
    refr.wrapU = Texture.CLAMP_ADDRESSMODE;
    refr.wrapV = Texture.CLAMP_ADDRESSMODE;
    scene.customRenderTargets.push(refr);
    shared = { depth, refr };
    SHARED.set(scene, shared);
    engine.onResizeObservable.add(() => {
      const rt = refr as unknown as { resize?: (s: { width: number; height: number }) => void };
      rt.resize?.(size());
    });
  }
  return shared;
}

/** Warped grid disc: dense at the centre, coarse at the rim (one draw call). */
function buildPatchGeometry(): VertexData {
  const n = 2 * PATCH_HALF + 1;
  const positions: number[] = [];
  const indices: number[] = [];
  const warp = (i: number): number => {
    const t = Math.abs(i) / PATCH_HALF;
    return Math.sign(i) * Math.pow(t, PATCH_POWER) * PATCH_D;
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      positions.push(warp(i - PATCH_HALF), 0, warp(j - PATCH_HALF));
    }
  }
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  return vd;
}

export function createOcean(scene: Scene, name: string, opts: OceanOptions): OceanResult {
  const waveSet = buildWaveSet(opts.waves, opts.seed);
  const shared = getShared(scene);
  const seaRadius = opts.radius * (1 + opts.waterLevel * opts.relief);
  const sunLight = scene.lights.find((l) => l.name === "sun") as
    | { intensity: number; diffuse: Color3 }
    | undefined;
  const sunTint = sunLight ? sunLight.diffuse.clone() : new Color3(1, 0.96, 0.9);

  const uniforms = [
    "view", "projection", "viewProjection", "world", "cameraPosition",
    "uPlanetCenter", "uRadius", "uSeaRadius", "uRelief", "uWaterLevel",
    "uPatchUp", "uPatchT", "uPatchB", "uPatchMode",
    "uHeightMap", "uShoreDetail", "uSurfEps", "uSurfScale",
    "uWaveAxis", "uWaveParam", "uWavePhase", "uWaveCount", "uLodScale",
    "uTime", "uShoalGain", "uBreakCoef", "uRefractAmt", "uChopEnable", "uGeomFade",
    "uSunDir", "uSunTint", "uSunIntensity", "uSunAmbient",
    "uDeepColor", "uShallowColor", "uFoamColor", "uShallowAlpha", "uDepthFade",
    "uFoamAmount", "uRippleAmount", "uRefraction", "uRefrStrength", "uSeaValid",
    "uDepthTex", "uRefrTex", "uCameraData", "uDebugMode",
  ];

  const vertexSource = `
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
    radial += ${glslNum(PATCH_BIAS)}; // bias over the shell: no z-fighting at the rim
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

  const fragmentSource = `
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
${skyGLSL(opts.sky)}
${swashGLSL(waveSet.swash)}

/** Foam breakup pattern (procedural): two scrolling octaves, crisp sub-metre scale. */
float foamPattern(vec3 p, float t) {
  float a = waterFbm(p * 2.6 + vec3(0.0, t * 0.35, t * 0.12), 2);
  float b = waterFbm(p * 6.0 - vec3(t * 0.22, 0.0, t * 0.31), 2);
  return smoothstep(0.3, 0.95, a * 0.62 + b * 0.5);
}

void main() {
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

  // --- Materials + meshes -------------------------------------------------
  const makeMaterial = (label: string, patchMode: number): ShaderMaterial => {
    const mat = new ShaderMaterial(
      `${name}-ocean-${label}`, scene,
      { vertexSource, fragmentSource },
      {
        attributes: ["position"],
        uniforms,
        samplers: ["uHeightMap", "uDepthTex", "uRefrTex"],
        needAlphaBlending: true,
        needAlphaTesting: false,
      }
    );
    mat.backFaceCulling = false;
    mat.setFloat("uPatchMode", patchMode);
    mat.setTexture("uHeightMap", opts.heightMap);
    mat.setTexture("uDepthTex", shared.depth.getDepthMap());
    mat.setTexture("uRefrTex", shared.refr);
    mat.setVector3("uPlanetCenter", opts.ground.position.clone());
    mat.setFloat("uRadius", opts.radius);
    mat.setFloat("uSeaRadius", seaRadius);
    mat.setFloat("uRelief", opts.relief);
    mat.setFloat("uWaterLevel", opts.waterLevel);
    mat.setFloat("uSurfEps", 6);
    mat.setVector3("uSurfScale", waveSet.surfScale.clone());
    mat.setArray4("uWaveAxis", Array.from(waveSet.axes));
    mat.setArray4("uWaveParam", Array.from(waveSet.params));
    mat.setFloats("uWavePhase", Array.from(waveSet.phases));
    mat.setFloat("uWaveCount", waveSet.count);
    mat.setFloat("uLodScale", 5);
    mat.setFloat("uShoalGain", 0.85);
    mat.setFloat("uBreakCoef", 0.5);
    mat.setFloat("uRefractAmt", 0.85);
    mat.setFloat("uChopEnable", 1);
    mat.setVector2("uGeomFade", new Vector2(120, 250));
    mat.setVector3("uDeepColor", new Vector3(opts.deepColor.r, opts.deepColor.g, opts.deepColor.b));
    mat.setVector3("uShallowColor", new Vector3(opts.shallowColor.r, opts.shallowColor.g, opts.shallowColor.b));
    mat.setVector3("uFoamColor", new Vector3(opts.foamColor.r, opts.foamColor.g, opts.foamColor.b));
    mat.setFloat("uShallowAlpha", opts.shallowAlpha);
    mat.setFloat("uDepthFade", opts.depthFade);
    mat.setFloat("uFoamAmount", 1);
    mat.setFloat("uRippleAmount", 1);
    mat.setFloat("uRefraction", 1);
    mat.setFloat("uRefrStrength", 1);
    mat.setFloat("uShoreDetail", 1);
    mat.setFloat("uSeaValid", 1);
    mat.setFloat("uTime", 0);
    mat.setFloat("uDebugMode", 0);
    mat.setVector4("uCameraData", new Vector4(0.1, 60000, 60000, 0));
    return mat;
  };

  const shell = Mesh.CreateSphere(`${name}-water`, Math.max(48, opts.segments), seaRadius * 2, scene);
  const shellMat = makeMaterial("shell", 0);
  shell.material = shellMat;
  shell.isPickable = false;

  const patchVD = buildPatchGeometry();
  const patch = new Mesh(`${name}-ocean-patch`, scene);
  patchVD.applyToMesh(patch, true);
  const patchMat = makeMaterial("patch", 1);
  patch.material = patchMat;
  patch.isPickable = false;
  patch.setEnabled(false);
  patch.alwaysSelectAsActiveMesh = true; // vertex shader positions, no culling

  const patchVerts = (2 * PATCH_HALF + 1) * (2 * PATCH_HALF + 1);

  // --- Per-frame state ----------------------------------------------------
  let time = 0;
  let patchUp = new Vector3(0, 1, 0);
  let patchT = new Vector3(1, 0, 0);
  let patchB = new Vector3(0, 0, 1);
  let lastQx = Infinity;
  let lastQy = Infinity;
  let qualityHigh = true;

  const update = (dt: number, sunDir: Vector3, isHost: boolean): void => {
    time += dt;

    const cam = scene.activeCamera;
    const camPos = cam ? cam.position : opts.ground.position;
    const toCam = camPos.subtract(opts.ground.position);
    const camDist = toCam.length();
    const alt = camDist - opts.radius;

    // Patch frame: nadir direction + tangent basis. The lattice snaps to the
    // centre cell in world space so it does not swim while flying; the wave
    // field itself is world-anchored, so snapping never moves the water.
    if (camDist > 1e-3) {
      const dir = toCam.scale(1 / camDist);
      const ref = Math.abs(dir.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
      const t = Vector3.Cross(ref, dir).normalize();
      const b = Vector3.Cross(dir, t).normalize();
      const cell = PATCH_D / (2 * PATCH_HALF);
      const qx = Math.round(Vector3.Dot(camPos, t) / cell) * cell;
      const qy = Math.round(Vector3.Dot(camPos, b) / cell) * cell;
      if (qx !== lastQx || qy !== lastQy || Vector3.Dot(dir, patchUp) < 0.999999) {
        lastQx = qx;
        lastQy = qy;
        patchUp = dir.clone();
        patchT = t;
        patchB = b;
      }
    }

    const maxAlt = qualityHigh ? PATCH_MAX_ALT : PATCH_MAX_ALT * 0.6;
    patch.setEnabled(alt > -30 && alt < maxAlt);

    // Day/night factor at the camera's spot on the planet.
    const toCamDir = camDist > 1e-3 ? toCam.scale(1 / camDist) : patchUp;
    const sunDot = Math.min(1, Math.max(0, Vector3.Dot(toCamDir, sunDir.scale(-1))));
    const daylight = sunDot * sunDot * (3 - 2 * sunDot);
    const ambient = 0.18 + 0.82 * daylight;
    const sunIntensity = sunLight ? sunLight.intensity : 3;

    // The host planet owns the shared depth + refraction targets.
    if (isHost) {
      shared.depth.getDepthMap().renderList = [opts.ground];
      shared.refr.renderList = [opts.ground];
      shared.refr.activeCamera = cam ?? null;
      shared.refr.refreshRate = qualityHigh ? 1 : 0;
    }

    const camera = scene.activeCamera;
    const camData = new Vector4(
      camera ? camera.minZ : 0.1,
      camera ? camera.maxZ : 60000,
      camera ? camera.maxZ - camera.minZ : 60000,
      0
    );
    const valid = isHost ? 1 : 0;

    for (const mat of [shellMat, patchMat]) {
      mat.setFloat("uTime", time);
      mat.setVector3("uSunDir", sunDir);
      mat.setVector3("uSunTint", new Vector3(sunTint.r, sunTint.g, sunTint.b));
      mat.setFloat("uSunIntensity", sunIntensity);
      mat.setFloat("uSunAmbient", ambient);
      mat.setVector3("uPatchUp", patchUp);
      mat.setVector3("uPatchT", patchT);
      mat.setVector3("uPatchB", patchB);
      mat.setVector4("uCameraData", camData);
      mat.setFloat("uSeaValid", valid);
    }
  };

  return {
    shell,
    patch,
    update,
    setQuality: (high: boolean) => {
      qualityHigh = high;
      for (const mat of [shellMat, patchMat]) {
        mat.setFloat("uShoreDetail", high ? 1 : 0);
        mat.setFloat("uChopEnable", high ? 1 : 0);
        mat.setFloat("uRefraction", high ? 1 : 0);
        mat.setFloat("uRippleAmount", high ? 1 : 0.25);
        mat.setFloat("uFoamAmount", high ? 1 : 0.35);
      }
      shared.refr.refreshRate = high ? 1 : 0;
    },
    waterRadiusAt: (dir: Vector3) => {
      const p = opts.ground.position.add(dir.scale(seaRadius));
      return seaRadius + cpuWaveHeightAt(waveSet, p, time);
    },
    stats: () => ({
      shellVerts: Math.max(48, opts.segments) * Math.max(48, opts.segments),
      patchVerts,
      waveCount: waveSet.count,
      time,
    }),
    elapsed: () => time,
    waveSet,
  };
}

/** Wave uniforms array sizes, exported for tests/debug. */
export const OCEAN_WAVE_FLOATS = MAX_WAVES * 4;
export const OCEAN_PATCH_VERTS = (2 * PATCH_HALF + 1) * (2 * PATCH_HALF + 1);
