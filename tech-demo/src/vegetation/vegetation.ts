/**
 * Instanced vegetation for the planet surfaces.
 *
 * Trees (broadleaf + conifer), shrubs and grass tufts are scattered
 * deterministically over the land using the same `terrainHeightNormalized`
 * field the ground mesh, ocean and flight collision sample, so instances sit
 * exactly on the visible surface. Each layer is a set of thin-instanced meshes
 * (one draw call per mesh), textured with CC0 cutout foliage cards
 * (ambientCG - see public/textures/vegetation/CREDITS.md) and alpha-tested.
 *
 * Placement rules per layer (all normalized units, see `VegetationLook`):
 * above the shore margin, below the tree/shrub/grass line, off the polar caps,
 * off steep slopes, and thinned by a low-frequency "forest" noise so trees
 * clump into woods with sparse outliers instead of an even sprinkle.
 *
 * The foliage materials get a subtle wind sway through a MaterialPlugin
 * (`CUSTOM_VERTEX_UPDATE_POSITION`, i.e. before the thin-instance transform),
 * with a per-instance phase derived from the instance translation in the
 * vertex shader (world3.xyz of the thin-instance matrix attributes).
 */
import {
  Color3,
  Material,
  Matrix,
  Mesh,
  PBRMaterial,
  Quaternion,
  Scene,
  Texture,
  Vector3,
  VertexData,
} from "@babylonjs/core";
import { fbm3 } from "../common/noise";
import { smoothstep } from "../common/math";
import { mulberry32 } from "../common/rng";
import { terrainHeightNormalized, type ShoresOptions } from "../common/heightField";
import { LayerLimits, Placed, VegetationLayer, makeGradient, scatter } from "../common/placement";
import { tangentBasis } from "../common/frames";
import { VegetationLook, defaultVegetationLook } from "./vegetationLook";
import { VegetationTextures, loadVegetationTextures } from "./vegetationTextures";
import { FoliageSwayPlugin, attachSway } from "./foliageSway";
import {
  GeoAccum,
  SpeciesGeometry,
  buildBroadleafGeometry,
  buildConiferGeometry,
  buildGrassGeometry,
  buildShrubGeometry,
} from "./vegetationGeometry";
// Re-exported so existing call sites keep working; new code imports
// placement/look types from ../common/placement and ./vegetationLook directly.
export type { LayerLimits, Placed, VegetationLayer };
export type { VegetationLook };
export { defaultVegetationLook };
export type { VegetationTextures };

/** Deterministic scatter RNG (shared mulberry32 kernel). */
const makeRng = mulberry32;

// ---------------------------------------------------------------------------
// Public build (placement kernel lives in placement.ts)
// ---------------------------------------------------------------------------

export interface VegetationOptions {
  name: string;
  seed: number;
  radius: number;
  relief: number;
  waterLevel: number;
  shore: ShoresOptions;
  /** The ground mesh (vegetation parents to it so local space is body space). */
  ground: Mesh;
  /** Body centre in world space. */
  center: Vector3;
  look: VegetationLook;
}

export interface VegetationStatus {
  trees: number;
  broadleaf: number;
  conifer: number;
  shrubs: number;
  grass: number;
  /** Total triangles across all instanced meshes. */
  tris: number;
  budget: number;
  ready: boolean;
  fallbacks: string[];
  limits: Record<VegetationLayer, LayerLimits>;
  radius: number;
  relief: number;
  waterLevel: number;
}

export interface VegetationHandle {
  meshes: Mesh[];
  status(): VegetationStatus;
  /** Up to `n` body-frame unit directions sampled from a layer's instances. */
  sampleDirs(layer: VegetationLayer, n: number): number[][];
  setVisible(on: boolean): void;
  update(dt: number): void;
}

/** Soft cap on the instanced triangle count (this is a demo, not a forest sim). */
export const VEGETATION_TRI_BUDGET = 220000;

export function buildVegetation(scene: Scene, opts: VegetationOptions): VegetationHandle {
  const { look, name, seed, radius, relief, waterLevel, shore } = opts;
  const textures = loadVegetationTextures(scene, name, look);

  const terrain = (x: number, y: number, z: number): number =>
    terrainHeightNormalized(x, y, z, seed, waterLevel, shore);

  const gradient = makeGradient(terrain);

  const rng = makeRng((seed ^ 0x5bd1e995) >>> 0);

  // --- Trees: clumped woods with sparse outliers, conifers on the high ground.
  const forestAt = (dir: Vector3): number => {
    const m =
      fbm3(
        dir.x * look.forestScale + 17,
        dir.y * look.forestScale,
        dir.z * look.forestScale,
        3,
        seed + 2100,
      ) *
        0.5 +
      0.5;
    return smoothstep(look.forestLo, look.forestHi, m);
  };
  interface TreePlace extends Placed {
    conifer: boolean;
  }
  const treeLimits: LayerLimits = {
    line: look.treeLine,
    polar: look.treePolar,
    slope: look.treeSlope,
    shore: look.treeShore,
  };
  const acceptedTrees = scatter(
    look.trees,
    look.trees * 10,
    300,
    150,
    terrain,
    gradient,
    waterLevel,
    treeLimits,
    (dir) => 0.12 + 0.88 * forestAt(dir),
    rng,
  );
  // Species pick: conifers take the cold/high ground, broadleaf fills the rest
  // (a per-direction noise keeps the split stable regardless of placement order).
  const trees: TreePlace[] = acceptedTrees.map((p) => {
    const cold = p.h > look.coniferAlt || Math.abs(p.dir.y) > 0.68;
    const pick = fbm3(p.dir.x * 11 + 5, p.dir.y * 11, p.dir.z * 11, 2, seed + 2400) * 0.5 + 0.5;
    return { ...p, conifer: cold || pick > look.broadleafRatio };
  });

  // --- Shrubs + grass: broader masks, thinner patches than the woods.
  const shrubMask = (dir: Vector3): number => {
    const m = fbm3(dir.x * 4.3 + 29, dir.y * 4.3, dir.z * 4.3, 2, seed + 2200) * 0.5 + 0.5;
    return 0.3 + 0.7 * smoothstep(0.3, 0.66, m);
  };
  const grassMask = (dir: Vector3): number => {
    const m = fbm3(dir.x * 6.1 + 41, dir.y * 6.1, dir.z * 6.1, 2, seed + 2300) * 0.5 + 0.5;
    return 0.35 + 0.65 * smoothstep(0.26, 0.64, m);
  };
  const shrubLimits: LayerLimits = {
    line: look.shrubLine,
    polar: look.shrubPolar,
    slope: look.shrubSlope,
    shore: look.shrubShore,
  };
  const grassLimits: LayerLimits = {
    line: look.grassLine,
    polar: look.grassPolar,
    slope: look.grassSlope,
    shore: look.grassShore,
  };
  const shrubs = scatter(
    look.shrubs,
    look.shrubs * 8,
    320,
    160,
    terrain,
    gradient,
    waterLevel,
    shrubLimits,
    (dir) => shrubMask(dir),
    rng,
  );
  const grass = scatter(
    look.grass,
    look.grass * 6,
    280,
    140,
    terrain,
    gradient,
    waterLevel,
    grassLimits,
    (dir) => grassMask(dir),
    rng,
  );

  // --- Instance matrices (body-local; the meshes are parented to the ground).
  const up = Vector3.Up();
  const alignQ = new Quaternion(),
    yawQ = new Quaternion(),
    finalQ = new Quaternion();
  const scale = new Vector3(),
    pos = new Vector3(),
    mat = new Matrix();

  const fillMatrices = (
    placed: Placed[],
    range: [number, number],
    sink: number,
    tint: Color3,
    withColors: boolean,
    footprint: number,
  ): { matrices: Float32Array; colors: Float32Array | null } => {
    const n = placed.length;
    const matrices = new Float32Array(n * 16);
    const colors = withColors ? new Float32Array(n * 4) : null;
    const tA = new Vector3(),
      tB = new Vector3(),
      d2 = new Vector3();
    // Plant at the LOWEST terrain point within the instance footprint, so
    // trunks/plants sit into the ground on slopes instead of hovering over it.
    const groundH = (dir: Vector3, h: number): number => {
      if (footprint <= 0) return h;
      const { t1, t2 } = tangentBasis(dir);
      tA.copyFrom(t1);
      tB.copyFrom(t2);
      const delta = footprint / radius;
      let m = h;
      for (const t of [tA, tB]) {
        for (const s of [delta, -delta]) {
          d2.copyFrom(dir).addInPlace(t.scale(s)).normalize();
          m = Math.min(m, terrain(d2.x, d2.y, d2.z));
        }
      }
      return m;
    };
    for (let i = 0; i < n; i++) {
      const { dir, h } = placed[i];
      const s = range[0] + (range[1] - range[0]) * rng();
      const sy = s * (0.85 + 0.35 * rng());
      const r = radius * (1 + groundH(dir, h) * relief);
      pos.copyFrom(dir).scaleInPlace(r - sink);
      Quaternion.FromUnitVectorsToRef(up, dir, alignQ);
      Quaternion.RotationAxisToRef(up, rng() * Math.PI * 2, yawQ);
      yawQ.multiplyToRef(alignQ, finalQ);
      scale.set(s, sy, s);
      Matrix.ComposeToRef(scale, finalQ, pos, mat);
      mat.copyToArray(matrices, i * 16);
      if (colors) {
        const shade = 0.78 + 0.42 * rng();
        colors[i * 4] = tint.r * shade;
        colors[i * 4 + 1] = tint.g * shade;
        colors[i * 4 + 2] = tint.b * shade;
        colors[i * 4 + 3] = 1;
      }
    }
    return { matrices, colors };
  };

  const broadleaf = trees.filter((t) => !t.conifer);
  const conifer = trees.filter((t) => t.conifer);
  const broadleafData = fillMatrices(broadleaf, look.treeScale, 0.2, look.broadleafTint, true, 1.3);
  const coniferData = fillMatrices(conifer, look.treeScale, 0.2, look.coniferTint, true, 1.0);
  const shrubData = fillMatrices(shrubs, look.shrubScale, 0.18, look.shrubTint, true, 0.9);
  const grassData = fillMatrices(grass, look.grassScale, 0.08, look.grassTint, true, 0);

  // --- Materials.
  const makeBark = (): PBRMaterial => {
    const m = new PBRMaterial(`${name}-veg-bark-mat`, scene);
    m.albedoTexture = textures.barkColor;
    m.bumpTexture = textures.barkNormal;
    m.metallic = 0;
    m.roughness = 0.88;
    m.environmentIntensity = 0.35;
    m.directIntensity = 1.0;
    return m;
  };
  const makeFoliage = (label: string, color: Texture, opacity: Texture): PBRMaterial => {
    const m = new PBRMaterial(`${name}-veg-${label}-mat`, scene);
    m.albedoTexture = color;
    m.opacityTexture = opacity;
    m.transparencyMode = Material.MATERIAL_ALPHATEST;
    m.alphaCutOff = 0.45;
    m.backFaceCulling = false;
    m.twoSidedLighting = true;
    m.metallic = 0;
    m.roughness = 0.9;
    m.environmentIntensity = 0.5;
    m.directIntensity = 1.0;
    return m;
  };
  const barkMat = makeBark();
  const plantsMat = makeFoliage("plants", textures.plantsColor, textures.plantsOpacity);
  const firMat = makeFoliage("fir", textures.firColor, textures.firOpacity);
  const canopyMat = makeFoliage("canopy", textures.canopyColor, textures.canopyOpacity);
  const needleMat = makeFoliage("needle", textures.needleColor, textures.needleOpacity);
  const materials: Record<SpeciesGeometry["material"], PBRMaterial> = {
    bark: barkMat,
    plants: plantsMat,
    fir: firMat,
    canopy: canopyMat,
    needles: needleMat,
  };

  const swayPlugins: FoliageSwayPlugin[] = [];
  if (look.sway) {
    for (const m of [plantsMat, firMat, canopyMat, needleMat]) {
      swayPlugins.push(attachSway(m, { amp: look.swayAmp, freq: look.swayFreq }));
    }
  }

  // --- Meshes (thin-instanced; trunk + canopy meshes share one matrix buffer).
  const meshes: Mesh[] = [];
  let tris = 0;

  const makeInstanced = (
    meshName: string,
    geo: GeoAccum,
    material: Material,
    data: { matrices: Float32Array; colors: Float32Array | null },
    count: number,
    useColors: boolean,
  ): void => {
    const vd = new VertexData();
    vd.positions = geo.positions;
    vd.normals = geo.normals;
    vd.uvs = geo.uvs;
    vd.indices = geo.indices;
    const mesh = new Mesh(`${name}-veg-${meshName}`, scene);
    vd.applyToMesh(mesh, false);
    mesh.material = material;
    mesh.parent = opts.ground;
    mesh.isPickable = false;
    mesh.thinInstanceSetBuffer("matrix", data.matrices, 16);
    // Trunks skip the instance tint so bark keeps its own colour (the tint
    // variation is tuned for foliage).
    if (useColors && data.colors) {
      mesh.thinInstanceSetBuffer("color", data.colors, 4);
      mesh.useVertexColors = true;
    }
    mesh.thinInstanceRefreshBoundingInfo(true);
    meshes.push(mesh);
    tris += (geo.indices.length / 3) * count;
  };

  for (const part of buildBroadleafGeometry(look)) {
    makeInstanced(
      part.meshName,
      part.geo,
      materials[part.material],
      broadleafData,
      broadleaf.length,
      part.material !== "bark",
    );
  }
  for (const part of buildConiferGeometry(look)) {
    makeInstanced(
      part.meshName,
      part.geo,
      materials[part.material],
      coniferData,
      conifer.length,
      part.material !== "bark",
    );
  }
  for (const part of buildShrubGeometry(look)) {
    makeInstanced(part.meshName, part.geo, materials[part.material], shrubData, shrubs.length, true);
  }
  for (const part of buildGrassGeometry(look)) {
    makeInstanced(part.meshName, part.geo, materials[part.material], grassData, grass.length, true);
  }

  // --- Layer registry for tests (instance translations are body-local).
  const treesMatrices = new Float32Array((broadleaf.length + conifer.length) * 16);
  treesMatrices.set(broadleafData.matrices, 0);
  treesMatrices.set(coniferData.matrices, broadleaf.length * 16);
  const layerData: Record<VegetationLayer, Float32Array> = {
    trees: treesMatrices,
    shrubs: shrubData.matrices,
    grass: grassData.matrices,
  };

  const center = opts.center.clone();
  let userVisible = true;
  let autoVisible = true;
  const applyVisibility = (): void => {
    const on = userVisible && autoVisible;
    for (const m of meshes) m.setEnabled(on);
  };

  let swayTime = 0;
  const update = (dt: number): void => {
    if (look.sway) {
      swayTime += dt;
      for (const p of swayPlugins) p.uSwayTime = swayTime;
    }
    const cam = scene.activeCamera;
    if (cam) {
      const dist = Vector3.Distance(cam.position, center);
      const near = dist < radius * 2.6;
      if (near !== autoVisible) {
        autoVisible = near;
        applyVisibility();
      }
    }
  };

  const limits: Record<VegetationLayer, LayerLimits> = {
    trees: treeLimits,
    shrubs: shrubLimits,
    grass: grassLimits,
  };

  return {
    meshes,
    status: () => ({
      trees: look.trees,
      broadleaf: broadleaf.length,
      conifer: conifer.length,
      shrubs: shrubs.length,
      grass: grass.length,
      tris: Math.round(tris),
      budget: VEGETATION_TRI_BUDGET,
      ready: [
        textures.barkColor,
        textures.barkNormal,
        textures.canopyColor,
        textures.canopyOpacity,
        textures.needleColor,
        textures.needleOpacity,
        textures.plantsColor,
        textures.plantsOpacity,
        textures.firColor,
        textures.firOpacity,
      ].every((t) => t.isReady()),
      fallbacks: [...textures.fallbacks],
      limits,
      radius,
      relief,
      waterLevel,
    }),
    sampleDirs: (layer: VegetationLayer, n: number): number[][] => {
      const data = layerData[layer];
      const count = data.length / 16;
      const out: number[][] = [];
      if (count === 0) return out;
      const take = Math.max(1, Math.min(n, count));
      const step = Math.max(1, Math.floor(count / take));
      for (let i = 0; i < count && out.length < take; i += step) {
        const x = data[i * 16 + 12],
          y = data[i * 16 + 13],
          z = data[i * 16 + 14];
        const l = Math.hypot(x, y, z) || 1;
        out.push([x / l, y / l, z / l]);
      }
      return out;
    },
    setVisible: (on: boolean) => {
      userVisible = on;
      applyVisibility();
    },
    update,
  };
}
