/**
 * Everything drawn for one celestial body, hung off a single root node.
 *
 * The root carries the body's pose in render space (inertial position minus
 * the floating origin, and its spin orientation), so terrain chunks, ocean,
 * vegetation and props are built once in the body-fixed frame and simply
 * ride along as the planet orbits and turns.
 */
import {
  Color3,
  PBRMaterial,
  RawTexture,
  Scene,
  Texture,
  TransformNode,
  Vector3,
  Quaternion,
} from "@babylonjs/core";
import type { BodyDef } from "../data/system";
import { TerrainView } from "../terrain/terrainView";
import type { TerrainWorkerPool } from "../terrain/workerPool";
import { hasOcean, seaRadius } from "../terrain/heightField";
import {
  attachTerrain,
  defaultTerrainLook,
  loadTerrainTextures,
  type TerrainHandle,
} from "./terrainMaterial";
import { createTerrainDepthMaterial } from "./terrainDepth";
import { attachWetSand, type WetSandPlugin } from "./wetSand";
import { HEIGHT_BAKE_H, HEIGHT_BAKE_W } from "../terrain/terrainJobs";
import { createOcean, type OceanResult } from "../ocean/ocean";
import { VegetationView } from "../vegetation/vegetationView";
import { createStarVisual, type StarVisual } from "./star";
import { atmoParams, type AtmoParams } from "../render/atmosphereModel";
import type { CloudParams } from "../render/cloudModel";
import type { SceneTargets } from "../render/sceneTargets";
import type { SkyPalette } from "../common/shaderChunks";
import type { WaveSet } from "../ocean/oceanWaves";
import type { BiomePalette, RGB } from "../terrain/biome";

const rgb = (c: Color3): RGB => [c.r, c.g, c.b];

/** Biome tint palette for the terrain workers, from a body's surface data. */
export function biomePalette(def: BodyDef): BiomePalette {
  const s = def.surface!;
  const o = def.ocean;
  return {
    low: rgb(s.lowTint),
    high: rgb(s.highTint),
    moist: [0.8, 0.92, 0.75],
    sand: [1.04, 0.98, 0.86],
    shallow: o ? rgb(o.shallowColor.scale(1.6)) : [0.5, 0.5, 0.5],
    deep: o ? rgb(o.deepColor.scale(3)) : [0.3, 0.3, 0.3],
    iceLat: s.iceCapLat,
    ice: [0.9, 0.92, 0.95],
  };
}

export class BodyView {
  readonly root: TransformNode;
  terrain: TerrainView | null = null;
  terrainHandle: TerrainHandle | null = null;
  ocean: OceanResult | null = null;
  vegetation: VegetationView | null = null;
  star: StarVisual | null = null;
  atmo: AtmoParams | null = null;
  clouds: CloudParams | null = null;
  /** Sea-level radius (m) on ocean worlds, else null. */
  seaRadius: number | null = null;
  private wetSand: WetSandPlugin | null = null;

  constructor(
    scene: Scene,
    readonly def: BodyDef,
    pool: TerrainWorkerPool,
    targets: SceneTargets,
    waves: WaveSet | null,
  ) {
    this.root = new TransformNode(`${def.id}-root`, scene);
    this.root.rotationQuaternion = Quaternion.Identity();

    if (def.kind === "star") {
      this.star = createStarVisual(scene, def.name, def.radius, def.star?.color ?? new Color3(1, 1, 1));
      this.star.root.parent = this.root;
      return;
    }

    const shape = def.terrain!;
    const s = def.surface!;
    const sea = hasOcean(shape) ? shape.waterLevel * shape.relief : null;

    // Ground material: PBR + triplanar texture blend (+ wet sand on ocean worlds).
    const mat = new PBRMaterial(`${def.id}-ground`, scene);
    mat.albedoColor = new Color3(1, 1, 1);
    mat.metallic = 0;
    mat.roughness = 0.93;
    mat.environmentIntensity = 0.35;
    const look = {
      ...defaultTerrainLook,
      baseColor: s.baseColor,
      baseNormal: s.baseNormal,
      rockColor: s.rockColor,
      rockNormal: s.rockNormal,
      baseTint: s.baseTint,
      snowStart: s.snowLine,
    };
    this.terrainHandle = attachTerrain(mat, {
      look,
      textures: loadTerrainTextures(scene, def.id, look),
      radius: shape.radius,
      relief: shape.relief,
      seaLevel: sea,
    });
    if (waves && sea !== null) {
      this.wetSand = attachWetSand(mat, { swash: waves.swash, seaLevel: sea, radius: shape.radius });
    }
    this.terrain = new TerrainView({
      scene,
      bodyId: def.id,
      shape,
      root: this.root,
      material: mat,
      pool,
      depthPass: {
        renderPassId: targets.depthRenderPassId,
        material: createTerrainDepthMaterial(scene, def.id, shape.radius, sea),
      },
    });

    if (def.ocean && sea !== null) {
      const palette: SkyPalette = def.atmosphere
        ? {
            skyTint: def.atmosphere.rayleighColor,
            skyStrength: 1,
            hazeTint: def.atmosphere.mieColor,
            hazeStrength: 0.22,
            hazeG: 0.7,
            sunTint: new Color3(1, 0.97, 0.92),
            sunGlow: 0.35,
          }
        : {
            skyTint: Color3.Black(),
            skyStrength: 0,
            hazeTint: Color3.Black(),
            hazeStrength: 0,
            hazeG: 0.7,
            sunTint: new Color3(1, 0.97, 0.92),
            sunGlow: 0.6,
          };
      this.ocean = createOcean(scene, def.id, {
        radius: shape.radius,
        seaLevel: sea,
        seed: shape.seed,
        segments: 128,
        root: this.root,
        waves: { seaState: def.ocean.seaState },
        sky: palette,
        shallowColor: def.ocean.shallowColor,
        deepColor: def.ocean.deepColor,
        foamColor: new Color3(0.97, 0.985, 1.0),
        shallowAlpha: 0.62,
        depthFade: 4.5,
        depthTexture: targets.depth(),
        refractionTexture: targets.refraction,
      });
      // Terrain height map for water depth / shore direction: baked by the
      // workers in strips (low priority, after the terrain around the camera).
      const W = HEIGHT_BAKE_W;
      const H = HEIGHT_BAKE_H;
      const STRIP = 32;
      const pixels = new Uint8Array(W * H * 4);
      let remaining = H / STRIP;
      for (let row0 = 0; row0 < H; row0 += STRIP) {
        pool
          .request(
            `${def.id}:bake:${row0}`,
            { kind: "bake", bodyId: def.id, width: W, height: H, row0, rows: STRIP },
            60000 + row0,
          )
          .then((r) => {
            if (r.kind !== "bake") return;
            pixels.set(r.data, r.row0 * W * 4);
            if (--remaining === 0 && this.ocean) {
              const tex = RawTexture.CreateRGBATexture(
                pixels,
                W,
                H,
                scene,
                false,
                false,
                // Nearest: the height is 16-bit packed into R/G, which can't be
                // hardware-filtered (the low byte wraps); the ocean shader
                // decodes four texels and interpolates the heights itself.
                Texture.NEAREST_SAMPLINGMODE,
              );
              tex.name = `${def.id}-heightmap`;
              tex.wrapU = Texture.WRAP_ADDRESSMODE;
              tex.wrapV = Texture.CLAMP_ADDRESSMODE;
              this.ocean.setHeightMap(tex);
            }
          })
          .catch(() => undefined);
      }
    }

    if (def.vegetation) {
      this.vegetation = new VegetationView(scene, def.id, shape, this.root, pool);
    }
    if (def.atmosphere) {
      const ground = sea !== null ? seaRadius(shape) : shape.radius;
      if (sea !== null) this.seaRadius = seaRadius(shape);
      this.atmo = atmoParams(def.radius, ground, def.atmosphere);
    }
    if (def.clouds) {
      this.clouds = {
        radius: def.radius,
        base: def.clouds.base,
        thickness: def.clouds.thickness,
        coverage: def.clouds.coverage,
        extinction: 0.045,
        windRate: 0.0006,
        evolve: 2,
      };
    }
  }

  /** Place the root in render space. */
  setPose(renderPos: Vector3, rotation: Quaternion): void {
    this.root.position.copyFrom(renderPos);
    this.root.rotationQuaternion!.copyFrom(rotation);
  }

  /** Clock for time-driven surface shaders (ocean waves, swash, star). */
  setTime(t: number): void {
    this.ocean?.setTime(t);
    if (this.wetSand) this.wetSand.uWetTime = t;
    this.star?.setTime(t);
  }
}
