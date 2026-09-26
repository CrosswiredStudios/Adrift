import {
  Scene,
  Mesh,
  VertexData,
  Vector3,
  Color3,
  Color4,
  PBRMaterial,
  ShaderMaterial,
  StandardMaterial,
  DynamicTexture,
  ParticleSystem,
  Texture,
  RawTexture,
} from "@babylonjs/core";
import { defaultShores, terrainHeightNormalized } from "../common/heightField";
import type { ShoresOptions } from "../common/heightField";
// Re-exported so existing planet/sun call sites keep working; new code
// should import from ../common/heightField directly.
export { defaultShores, terrainHeightNormalized };
export type { ShoresOptions };
import { Constants } from "@babylonjs/core/Engines/constants";
import { fbm3 } from "../common/noise";
import { createOcean, OceanResult } from "../ocean/ocean";
import { WaveSettings } from "../ocean/oceanWaves";
import { SkyPalette } from "../common/shaderChunks";
import { attachTerrain, loadTerrainTextures, TerrainHandle, TerrainLook } from "./terrainMaterial";
import { attachWetSand } from "./wetSand";
import { buildGroundGeometry } from "./groundGeometry";
import { buildClouds, buildNightLights, Clouds } from "./skyExtras";

/** Ocean look, overridable per planet. */
export interface OceanLook {
  shallowColor: Color3;
  deepColor: Color3;
  foamColor: Color3;
  /** Alpha of the water at the shore (deep water is opaque). */
  shallowAlpha: number;
  /** Depth (world units) over which shallow water turns deep. */
  depthFade: number;
}

export interface SurfaceOptions {
  radius: number;
  seed: number;
  /** Max terrain relief as fraction of radius. */
  relief: number;
  segments: number;
  groundAlbedo: Color3;
  waterLevel: number; // normalized height [-1,1] below which is ocean
  waterColor: Color3;
  iceCaps: boolean;
  nightLights: boolean;
  clouds: boolean;
  cloudCoverage: number;
  /** Coastal shaping (see ShoresOptions). */
  shore: ShoresOptions;
  /** Ocean look overrides. */
  ocean?: Partial<OceanLook>;
  /** Wave settings (sea state / wind). Defaults to a mild sea. */
  waves?: WaveSettings;
  /** Atmosphere palette used for water reflections. */
  sky?: SkyPalette;
  /** Ground texture blend (undefined = plain vertex-coloured ground). */
  terrain?: TerrainLook;
  /** World position of the planet centre (the ocean meshes stay at the origin). */
  position?: Vector3;
}

export interface SurfaceResult {
  ground: Mesh;
  water: Mesh | null;
  clouds: Mesh | null;
  /** Volumetric deck handle (null when clouds are disabled). */
  cloudDeck: Clouds | null;
  ocean: OceanResult | null;
  /** Ground texture blend handle (null when no terrain look was configured). */
  terrain: TerrainHandle | null;
  update: (dt: number, sunDir: Vector3, isHost?: boolean) => void;
}

const defaultOptions: SurfaceOptions = {
  radius: 600,
  seed: 1337,
  relief: 0.02,
  segments: 128,
  groundAlbedo: new Color3(0.25, 0.45, 0.3),
  waterLevel: -0.05,
  waterColor: new Color3(0.05, 0.2, 0.35),
  iceCaps: true,
  nightLights: true,
  clouds: true,
  cloudCoverage: 0.45,
  shore: defaultShores,
};

/**
 * Bake the SHAPED terrain height into an RG (16-bit fixed point) lat-long
 * texture for the ocean shaders, which use it for water depth, shore direction,
 * shoaling/breaking and the surf-zone mask. Encoding is linear, so bilinear
 * filtering reconstructs the 16-bit value exactly.
 */
export function bakeTerrainHeightTexture(
  scene: Scene,
  name: string,
  opts: SurfaceOptions,
  width = 512,
  height = 256,
): RawTexture {
  const data = new Uint8Array(width * height * 4);
  for (let iy = 0; iy < height; iy++) {
    const v = iy / (height - 1);
    const theta = v * Math.PI;
    const sinT = Math.sin(theta),
      cosT = Math.cos(theta);
    for (let ix = 0; ix < width; ix++) {
      const u = ix / width;
      const phi = (u - 0.5) * Math.PI * 2; // matches the shader's atan2 convention
      const nx = sinT * Math.cos(phi),
        ny = cosT,
        nz = sinT * Math.sin(phi);
      const h = terrainHeightNormalized(nx, ny, nz, opts.seed, opts.waterLevel, opts.shore);
      const u16 = Math.max(0, Math.min(65535, Math.round(((h + 1.5) / 3) * 65535)));
      const o = (iy * width + ix) * 4;
      data[o] = (u16 >> 8) & 255;
      data[o + 1] = u16 & 255;
      data[o + 2] = 0;
      data[o + 3] = 255;
    }
  }
  const tex = RawTexture.CreateRGBATexture(
    data,
    width,
    height,
    scene,
    false,
    false,
    Texture.BILINEAR_SAMPLINGMODE,
  );
  tex.name = `${name}-heightmap`;
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  return tex;
}

/** Procedural ground + ocean + clouds + night lights for one planet. */
export function buildPlanetSurface(
  scene: Scene,
  name: string,
  partial: Partial<SurfaceOptions>,
): SurfaceResult {
  const opts: SurfaceOptions = { ...defaultOptions, ...partial };

  const geo = buildGroundGeometry(opts);
  const groundVD = new VertexData();
  groundVD.positions = geo.positions;
  groundVD.normals = geo.normals;
  groundVD.indices = geo.indices;
  groundVD.uvs = geo.uvs;
  groundVD.colors = geo.colors;
  const ground = new Mesh(`${name}-ground`, scene);
  groundVD.applyToMesh(ground, true);
  ground.hasVertexAlpha = false;
  if (opts.position) ground.position.copyFrom(opts.position);

  const groundMat = new PBRMaterial(`${name}-ground-mat`, scene);
  groundMat.albedoColor = new Color3(1, 1, 1); // multiplied by vertex colors
  ground.hasVertexAlpha = false;
  ground.useVertexColors = true;
  groundMat.metallic = 0.0;
  groundMat.roughness = 0.93;
  groundMat.environmentIntensity = 0.35;
  groundMat.directIntensity = 1.0;
  ground.material = groundMat;

  // Ground texture blend (base pair vs rock by slope + altitude + noise), with
  // the snow line gated by `iceCaps` so airless bodies stay bare.
  let terrain: TerrainHandle | null = null;
  if (opts.terrain) {
    const look: TerrainLook = {
      ...opts.terrain,
      snowStart: opts.iceCaps ? opts.terrain.snowStart : null,
    };
    const textures = loadTerrainTextures(scene, name, look);
    terrain = attachTerrain(groundMat, {
      look,
      textures,
      radius: opts.radius,
      relief: opts.relief,
      waterLevel: opts.waterLevel,
    });
    if (geo.terrainUvs) ground.setVerticesData("terrainUv", geo.terrainUvs, false, 2);
  }

  // Ocean: two-layer procedural water (see ocean.ts). The mesh name is kept
  // for the smoke test; the shader now handles depth colour, surf and run-up.
  const heightMap = bakeTerrainHeightTexture(scene, name, opts);
  const oceanLook: OceanLook = {
    shallowColor: new Color3(0.12, 0.5, 0.55),
    deepColor: new Color3(0.008, 0.055, 0.115),
    foamColor: new Color3(0.97, 0.985, 1.0),
    shallowAlpha: 0.62,
    depthFade: 4.5,
    ...(opts.ocean ?? {}),
  };
  const ocean =
    opts.waterLevel < 0
      ? createOcean(scene, name, {
          radius: opts.radius,
          relief: opts.relief,
          waterLevel: opts.waterLevel,
          seed: opts.seed,
          segments: opts.segments,
          heightMap,
          ground,
          waves: opts.waves ?? { seaState: "mild" },
          sky: opts.sky ?? {
            skyTint: new Color3(0.35, 0.6, 1),
            skyStrength: 1.0,
            hazeTint: new Color3(1, 0.97, 0.92),
            hazeStrength: 0.25,
            hazeG: 0.7,
            sunTint: new Color3(1, 0.97, 0.92),
            sunGlow: 0.35,
          },
          shallowColor: oceanLook.shallowColor,
          deepColor: oceanLook.deepColor,
          foamColor: oceanLook.foamColor,
          shallowAlpha: oceanLook.shallowAlpha,
          depthFade: oceanLook.depthFade,
        })
      : null;
  const water: Mesh | null = ocean ? ocean.shell : null;

  // Wet sand band on the ground, sharing the ocean's swash field + clock.
  const wetSand = ocean
    ? attachWetSand(groundMat, {
        heightMap,
        swash: ocean.waveSet.swash,
        waterLevel: opts.waterLevel,
        relief: opts.relief,
        radius: opts.radius,
      })
    : null;

  // Night-side city lights + cloud deck (see skyExtras.ts). The deck is a
  // camera post-process, so it needs the active camera; the planet center is
  // synced below (makePlanet calls setCenter with the world position).
  const night = opts.nightLights
    ? buildNightLights(scene, name, { seed: opts.seed, radius: opts.radius })
    : null;
  night?.attachTo(ground);
  const clouds = opts.clouds
    ? buildClouds(
        scene,
        name,
        {
          radius: opts.radius,
          relief: opts.relief,
          segments: opts.segments,
          coverage: opts.cloudCoverage,
          seed: opts.seed,
        },
        scene.activeCamera ?? undefined,
      )
    : null;
  if (clouds && opts.position) clouds.setCenter(opts.position);

  const update = (dt: number, sunDir: Vector3, isHost = true): void => {
    ocean?.update(dt, sunDir, isHost);
    wetSand?.setTime(ocean?.elapsed() ?? 0);
    clouds?.update(dt, sunDir);
    night?.update(sunDir);
  };

  void Color4;
  void ParticleSystem;
  void Texture;
  return { ground, water, clouds: clouds?.mesh ?? null, cloudDeck: clouds, ocean, terrain, update };
}
