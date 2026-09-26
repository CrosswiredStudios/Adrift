import { Scene, Mesh, Vector2, Vector3, Vector4, Color3, ShaderMaterial, Texture } from "@babylonjs/core";
import { getOceanShared } from "./oceanTargets";
import { DEFAULT_PATCH, PatchConfig, buildPatchGeometry } from "./oceanGeometry";
import { WaveSet, WaveSettings, buildWaveSet, cpuWaveHeightAt, MAX_WAVES } from "./oceanWaves";
import { SkyPalette } from "../common/shaderChunks";
import {
  OCEAN_SAMPLERS,
  OCEAN_UNIFORMS,
  buildOceanFragmentSource,
  buildOceanVertexSource,
} from "./oceanShaders";

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

// Patch layout lives in oceanGeometry.ts (DEFAULT_PATCH); the shared
// per-scene depth/refraction targets live in oceanTargets.ts.

export function createOcean(
  scene: Scene,
  name: string,
  opts: OceanOptions,
  patchCfg: PatchConfig = DEFAULT_PATCH,
): OceanResult {
  const waveSet = buildWaveSet(opts.waves, opts.seed);
  const shared = getOceanShared(scene);
  const seaRadius = opts.radius * (1 + opts.waterLevel * opts.relief);
  const sunLight = scene.lights.find((l) => l.name === "sun") as
    { intensity: number; diffuse: Color3 } | undefined;
  const sunTint = sunLight ? sunLight.diffuse.clone() : new Color3(1, 0.96, 0.9);

  // Shader text lives in oceanShaders.ts; the sources below are built per
  // planet from its sky palette + wave set (byte-identical to the old inline
  // strings for default options).
  const uniforms = OCEAN_UNIFORMS;
  const vertexSource = buildOceanVertexSource(waveSet, patchCfg.bias);
  const fragmentSource = buildOceanFragmentSource(opts.sky, waveSet);

  // --- Materials + meshes -------------------------------------------------
  const makeMaterial = (label: string, patchMode: number): ShaderMaterial => {
    const mat = new ShaderMaterial(
      `${name}-ocean-${label}`,
      scene,
      { vertexSource, fragmentSource },
      {
        attributes: ["position"],
        uniforms,
        samplers: [...OCEAN_SAMPLERS],
        needAlphaBlending: true,
        needAlphaTesting: false,
      },
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
    mat.setVector3(
      "uShallowColor",
      new Vector3(opts.shallowColor.r, opts.shallowColor.g, opts.shallowColor.b),
    );
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

  const patchVD = buildPatchGeometry(patchCfg);
  const patch = new Mesh(`${name}-ocean-patch`, scene);
  patchVD.applyToMesh(patch, true);
  const patchMat = makeMaterial("patch", 1);
  patch.material = patchMat;
  patch.isPickable = false;
  patch.setEnabled(false);
  patch.alwaysSelectAsActiveMesh = true; // vertex shader positions, no culling

  const patchVerts = (2 * patchCfg.half + 1) * (2 * patchCfg.half + 1);

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
      const cell = patchCfg.radius / (2 * patchCfg.half);
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

    const maxAlt = qualityHigh ? patchCfg.maxAlt : patchCfg.maxAlt * 0.6;
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
      0,
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
export const OCEAN_PATCH_VERTS = (2 * DEFAULT_PATCH.half + 1) * (2 * DEFAULT_PATCH.half + 1);
