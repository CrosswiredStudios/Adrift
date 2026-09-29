import {
  Scene,
  Mesh,
  TransformNode,
  Vector2,
  Vector3,
  Color3,
  ShaderMaterial,
  Texture,
} from "@babylonjs/core";
import { DEFAULT_PATCH, PatchConfig, buildPatchGeometry } from "./oceanGeometry";
import { WaveSet, WaveSettings, buildWaveSet, cpuWaveHeightAt } from "./oceanWaves";
import { SkyPalette } from "../common/shaderChunks";
import {
  OCEAN_SAMPLERS,
  OCEAN_UNIFORMS,
  buildOceanFragmentSource,
  buildOceanVertexSource,
} from "./oceanShaders";
import { tangentBasis } from "../common/frames";

/**
 * Two-layer procedural ocean for a spherical body (see docs/tech-demo.md):
 *
 *  - `shell`: a sphere at sea level, always on (orbital view). Fragment-
 *    shaded waves; geometry only carries the slow run-up.
 *  - `patch`: a camera-following warped disc (dense near the camera) with
 *    the real Gerstner geometry, the surf zone (shoaling, refraction,
 *    breaking foam) and the run-up.
 *
 * Both are children of the body root and are computed in the body-fixed
 * frame, so the waves stay anchored to the planet under spin and floating
 * origin. Depth + shore direction come from the baked terrain height map;
 * the exact waterline comes from the scene depth texture; the refraction
 * composite samples a half-res colour target of the ground.
 */

export interface OceanOptions {
  radius: number;
  /** Sea level above the mean radius (m). */
  seaLevel: number;
  seed: number;
  /** Shell tessellation. */
  segments: number;
  /** Body root node (the ocean meshes are its children). */
  root: TransformNode;
  waves: WaveSettings;
  sky: SkyPalette;
  shallowColor: Color3;
  deepColor: Color3;
  foamColor: Color3;
  shallowAlpha: number;
  depthFade: number;
  /** Scene depth (camera-space z) and the refraction colour target. */
  depthTexture: Texture;
  refractionTexture: Texture;
}

export interface OceanFrame {
  /** Camera position in the body frame. */
  camLocal: Vector3;
  /** Sun light travel direction in the body frame. */
  sunDirLocal: Vector3;
  sunTint: Color3;
  sunIntensity: number;
  /** 0..1 daylight at the camera's spot (dims the water at night). */
  daylight: number;
  /** True for the body the camera is at (owns the depth/refraction targets). */
  isHost: boolean;
}

export interface OceanResult {
  shell: Mesh;
  patch: Mesh;
  /** Advance the wave clock to sim time `t` (seconds). */
  setTime(t: number): void;
  /** Per-frame visual update. */
  update(frame: OceanFrame): void;
  setQuality(high: boolean): void;
  /** Supply the baked terrain height map once the workers finish it. */
  setHeightMap(tex: Texture): void;
  /** Water surface radius (from the body centre) along a unit direction (body frame). */
  waterRadiusAt(dir: Vector3): number;
  seaRadius: number;
  time(): number;
  stats(): {
    shellVerts: number;
    patchVerts: number;
    waveCount: number;
    time: number;
    heightMap: boolean;
    patchOn: boolean;
  };
  waveSet: WaveSet;
  materials: ShaderMaterial[];
}

export function createOcean(
  scene: Scene,
  name: string,
  opts: OceanOptions,
  patchCfg: PatchConfig = DEFAULT_PATCH,
): OceanResult {
  const waveSet = buildWaveSet(opts.waves, opts.seed);
  const seaRadius = opts.radius + opts.seaLevel;

  const vertexSource = buildOceanVertexSource(waveSet, patchCfg.bias);
  const fragmentSource = buildOceanFragmentSource(opts.sky, waveSet);

  const makeMaterial = (label: string, patchMode: number): ShaderMaterial => {
    const mat = new ShaderMaterial(
      `${name}-ocean-${label}`,
      scene,
      { vertexSource, fragmentSource },
      {
        attributes: ["position"],
        uniforms: OCEAN_UNIFORMS,
        samplers: OCEAN_SAMPLERS,
        needAlphaBlending: true,
        needAlphaTesting: false,
      },
    );
    mat.backFaceCulling = false;
    mat.useLogarithmicDepth = true;
    mat.setFloat("uPatchMode", patchMode);
    mat.setTexture("uDepthTex", opts.depthTexture);
    mat.setTexture("uRefrTex", opts.refractionTexture);
    mat.setTexture("uHeightMap", opts.depthTexture); // placeholder until the bake arrives
    mat.setFloat("uHeightValid", 0);
    mat.setFloat("uRadius", opts.radius);
    mat.setFloat("uSeaRadius", seaRadius);
    mat.setFloat("uSeaLevel", opts.seaLevel);
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
    mat.setColor3("uDeepColor", opts.deepColor);
    mat.setColor3("uShallowColor", opts.shallowColor);
    mat.setColor3("uFoamColor", opts.foamColor);
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
    mat.setVector3("uCamLocal", new Vector3(0, seaRadius + 100, 0));
    mat.setVector3("uSunDirLocal", new Vector3(0, -1, 0));
    return mat;
  };

  const shell = Mesh.CreateSphere(`${name}-water`, Math.max(64, opts.segments), seaRadius * 2, scene);
  const shellMat = makeMaterial("shell", 0);
  shell.material = shellMat;
  shell.isPickable = false;
  shell.parent = opts.root;

  const patch = new Mesh(`${name}-ocean-patch`, scene);
  buildPatchGeometry(patchCfg).applyToMesh(patch, true);
  const patchMat = makeMaterial("patch", 1);
  patch.material = patchMat;
  patch.isPickable = false;
  patch.setEnabled(false);
  patch.parent = opts.root;
  patch.alwaysSelectAsActiveMesh = true; // vertex shader positions: no CPU culling
  const materials = [shellMat, patchMat];

  let time = 0;
  let patchUp = new Vector3(0, 1, 0);
  let patchT = new Vector3(1, 0, 0);
  let patchB = new Vector3(0, 0, 1);
  let lastQx = Infinity;
  let lastQy = Infinity;
  let qualityHigh = true;
  let heightReady = false;
  const tint = new Vector3();

  const update = (f: OceanFrame): void => {
    const camDist = f.camLocal.length();
    const alt = camDist - seaRadius;

    // Patch frame (body frame): nadir direction + tangent basis. The lattice
    // snaps to whole cells so it doesn't swim; the wave field itself is
    // anchored to the body, so snapping never moves the water.
    if (camDist > 1e-3) {
      const dir = f.camLocal.scale(1 / camDist);
      const { t1, t2 } = tangentBasis(dir);
      const cell = patchCfg.radius / (2 * patchCfg.half);
      const qx = Math.round(Vector3.Dot(f.camLocal, t1) / cell) * cell;
      const qy = Math.round(Vector3.Dot(f.camLocal, t2) / cell) * cell;
      if (qx !== lastQx || qy !== lastQy || Vector3.Dot(dir, patchUp) < 0.999999) {
        lastQx = qx;
        lastQy = qy;
        patchUp = dir;
        patchT = t1;
        patchB = t2;
      }
    }
    const maxAlt = qualityHigh ? patchCfg.maxAlt : patchCfg.maxAlt * 0.6;
    patch.setEnabled(alt > -30 && alt < maxAlt);

    tint.set(f.sunTint.r, f.sunTint.g, f.sunTint.b);
    const ambient = 0.12 + 0.88 * f.daylight;
    for (const mat of materials) {
      mat.setFloat("uTime", time);
      mat.setVector3("uCamLocal", f.camLocal);
      mat.setVector3("uSunDirLocal", f.sunDirLocal);
      mat.setVector3("uSunTint", tint);
      mat.setFloat("uSunIntensity", f.sunIntensity);
      mat.setFloat("uSunAmbient", ambient);
      mat.setVector3("uPatchUp", patchUp);
      mat.setVector3("uPatchT", patchT);
      mat.setVector3("uPatchB", patchB);
      mat.setFloat("uSeaValid", f.isHost ? 1 : 0);
    }
  };

  const waterPoint = new Vector3();
  return {
    shell,
    patch,
    setTime: (t: number) => {
      time = t;
    },
    update,
    setQuality: (high: boolean) => {
      qualityHigh = high;
      for (const mat of materials) {
        mat.setFloat("uShoreDetail", high ? 1 : 0);
        mat.setFloat("uChopEnable", high ? 1 : 0);
        mat.setFloat("uRefraction", high ? 1 : 0);
        mat.setFloat("uRippleAmount", high ? 1 : 0.25);
        mat.setFloat("uFoamAmount", high ? 1 : 0.35);
      }
    },
    setHeightMap: (tex: Texture) => {
      heightReady = true;
      for (const mat of materials) {
        mat.setTexture("uHeightMap", tex);
        mat.setFloat("uHeightValid", 1);
      }
    },
    waterRadiusAt: (dir: Vector3) => {
      waterPoint.copyFrom(dir).scaleInPlace(seaRadius);
      return seaRadius + cpuWaveHeightAt(waveSet, waterPoint, time);
    },
    seaRadius,
    time: () => time,
    stats: () => ({
      shellVerts: shell.getTotalVertices(),
      patchVerts: patch.getTotalVertices(),
      waveCount: waveSet.count,
      time,
      heightMap: heightReady,
      patchOn: patch.isEnabled(),
    }),
    waveSet,
    materials,
  };
}
