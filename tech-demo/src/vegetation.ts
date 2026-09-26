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
  Color3, DynamicTexture, Material, MaterialPluginBase, Matrix, Mesh, PBRMaterial,
  Quaternion, Scene, Texture, UniformBuffer, Vector3, VertexData,
} from "@babylonjs/core";
import { fbm3 } from "./noise";
import { terrainHeightNormalized, type ShoresOptions } from "./planetSurface";
import { glslNum } from "./shaderChunks";
import { makeFallbackTexture, makeFlatNormal } from "./terrainMaterial";

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smoothstep01 = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Deterministic little RNG (same spirit as the night-lights speckle). */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Equal-area point `i` of `n` on the unit sphere (Fibonacci lattice). */
function fibDir(out: Vector3, i: number, n: number): Vector3 {
  const k = i + 0.5;
  const cosT = 1 - (2 * k) / n;
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const phi = i * 2.399963229728653; // golden angle
  return out.set(sinT * Math.cos(phi), cosT, sinT * Math.sin(phi));
}

export interface VegetationLook {
  /** Bark maps for the trunks (albedo + normal). */
  barkColor: string;
  barkNormal: string;
  /** Broadleaf canopy cutouts (dense beech leaves). */
  canopyColor: string;
  canopyOpacity: string;
  /** Conifer canopy cutouts (fir needle branches). */
  needleColor: string;
  needleOpacity: string;
  /** Shrub / weed cutouts. */
  plantsColor: string;
  plantsOpacity: string;
  /** Grass tufts. */
  firColor: string;
  firOpacity: string;
  /** Tree instance cap (split between the two species by `broadleafRatio`). */
  trees: number;
  broadleafRatio: number;
  shrubs: number;
  grass: number;
  /** Normalized height above which the layer stops growing (tree line). */
  treeLine: number;
  shrubLine: number;
  grassLine: number;
  /** Reject |dir.y| above this (polar caps / ice). */
  treePolar: number;
  shrubPolar: number;
  grassPolar: number;
  /** Reject terrain gradient (normalized height per radian) above this. */
  treeSlope: number;
  shrubSlope: number;
  grassSlope: number;
  /** Required height above sea level (normalized) - keeps off the beach/wash. */
  treeShore: number;
  shrubShore: number;
  grassShore: number;
  /** Forest clumping: fbm frequency + accept window on the 0..1 mask. */
  forestScale: number;
  forestLo: number;
  forestHi: number;
  /** Trees above this normalized height always become conifers. */
  coniferAlt: number;
  /** Base heights (world units) for the shared geometry. */
  treeHeight: number;
  coniferHeight: number;
  shrubHeight: number;
  grassHeight: number;
  /** Per-instance uniform scale ranges. */
  treeScale: [number, number];
  shrubScale: [number, number];
  grassScale: [number, number];
  /** Instance tints multiplied with the texture. */
  broadleafTint: Color3;
  coniferTint: Color3;
  shrubTint: Color3;
  grassTint: Color3;
  /** Subtle wind sway on the cutout materials. */
  sway: boolean;
  swayAmp: number;
  swayFreq: number;
}

/** Vael-flavoured defaults: temperate, wooded lowlands, conifers up the hills. */
export const defaultVegetationLook: VegetationLook = {
  barkColor: "/textures/vegetation/bark_color.jpg",
  barkNormal: "/textures/vegetation/bark_normal.jpg",
  canopyColor: "/textures/vegetation/canopy_color.jpg",
  canopyOpacity: "/textures/vegetation/canopy_opacity.jpg",
  needleColor: "/textures/vegetation/needles_color.jpg",
  needleOpacity: "/textures/vegetation/needles_opacity.jpg",
  plantsColor: "/textures/vegetation/plants_color.jpg",
  plantsOpacity: "/textures/vegetation/plants_opacity.jpg",
  firColor: "/textures/vegetation/grass_color.jpg",
  firOpacity: "/textures/vegetation/grass_opacity.jpg",
  trees: 3200,
  broadleafRatio: 0.72,
  shrubs: 2600,
  grass: 1600,
  treeLine: 0.45,
  shrubLine: 0.62,
  grassLine: 0.52,
  treePolar: 0.78,
  shrubPolar: 0.88,
  grassPolar: 0.85,
  treeSlope: 2.7,
  shrubSlope: 3.2,
  grassSlope: 3.6,
  treeShore: 0.02,
  shrubShore: 0.012,
  grassShore: 0.008,
  forestScale: 2.6,
  forestLo: 0.36,
  forestHi: 0.6,
  coniferAlt: 0.28,
  treeHeight: 8.5,
  coniferHeight: 10,
  shrubHeight: 2.2,
  grassHeight: 1.5,
  treeScale: [0.7, 1.35],
  shrubScale: [0.75, 1.5],
  grassScale: [0.7, 1.6],
  broadleafTint: new Color3(1.0, 1.18, 0.85),
  coniferTint: new Color3(0.95, 1.12, 0.85),
  shrubTint: new Color3(1.0, 1.18, 0.85),
  grassTint: new Color3(0.95, 1.05, 0.7),
  sway: true,
  swayAmp: 0.14,
  swayFreq: 1.1,
};

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

export interface VegetationTextures {
  barkColor: Texture;
  barkNormal: Texture;
  canopyColor: Texture;
  canopyOpacity: Texture;
  needleColor: Texture;
  needleOpacity: Texture;
  plantsColor: Texture;
  plantsOpacity: Texture;
  firColor: Texture;
  firOpacity: Texture;
  /** Names of the maps that failed to load and were replaced procedurally. */
  fallbacks: string[];
}

/** Soft leafy blob mask (luminance = opacity) used when an opacity map is missing. */
function makeFallbackOpacity(scene: Scene, name: string, seed: number): Texture {
  const size = 128;
  const tex = new DynamicTexture(name, { width: size, height: size }, scene, true);
  const ctx = tex.getContext();
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const v = fbm3(x * 0.055, y * 0.055, seed * 0.17, 4, seed) * 0.5 + 0.5;
      const dx = (x / size - 0.5) * 2, dy = (y / size - 0.5) * 2;
      const edge = 1 - Math.min(1, Math.hypot(dx, dy));
      const lum = clamp01(v * 1.05 + edge * 0.75 - 0.5);
      const g = Math.round(lum * 255);
      d[o] = g; d[o + 1] = g; d[o + 2] = g; d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.update();
  return tex;
}

function loadOne(
  scene: Scene, name: string, url: string, fallbacks: string[], makeFallback: () => Texture,
  assign: (t: Texture) => void
): Texture {
  const tex = new Texture(url, scene, false, false, Texture.TRILINEAR_SAMPLINGMODE, null, () => {
    fallbacks.push(name);
    assign(makeFallback());
  });
  tex.name = name;
  tex.anisotropicFilteringLevel = 4;
  return tex;
}

/** Loads the ten vegetation maps, substituting procedural stand-ins on failure. */
export function loadVegetationTextures(scene: Scene, name: string, look: VegetationLook): VegetationTextures {
  const fallbacks: string[] = [];
  const green = (r: number, g: number, b: number, seed: number): (() => Texture) =>
    () => makeFallbackTexture(scene, `${name}-veg-fb-${seed}`, new Color3(r, g, b), seed);
  const opacityFb = (seed: number): (() => Texture) => () =>
    makeFallbackOpacity(scene, `${name}-veg-opacity-fb-${seed}`, seed);
  // The opacity maps are grayscale; the shader reads their luminance (and they
  // must not go through the sRGB conversion the albedo maps get).
  const asOpacity = (t: Texture): Texture => {
    t.getAlphaFromRGB = true;
    t.gammaSpace = false;
    return t;
  };

  const out = {} as VegetationTextures;
  out.fallbacks = fallbacks;
  out.barkColor = loadOne(scene, `${name}-veg-bark`, look.barkColor, fallbacks, green(0.32, 0.24, 0.16, 3), (t) => { out.barkColor = t; });
  out.barkNormal = loadOne(scene, `${name}-veg-bark-n`, look.barkNormal, fallbacks, () => makeFlatNormal(scene, `${name}-veg-flat-n`), (t) => { out.barkNormal = t; });
  out.canopyColor = loadOne(scene, `${name}-veg-canopy`, look.canopyColor, fallbacks, green(0.36, 0.52, 0.24, 17), (t) => { out.canopyColor = t; });
  out.canopyOpacity = loadOne(scene, `${name}-veg-canopy-o`, look.canopyOpacity, fallbacks, opacityFb(19), (t) => { out.canopyOpacity = asOpacity(t); });
  out.needleColor = loadOne(scene, `${name}-veg-needle`, look.needleColor, fallbacks, green(0.24, 0.42, 0.2, 23), (t) => { out.needleColor = t; });
  out.needleOpacity = loadOne(scene, `${name}-veg-needle-o`, look.needleOpacity, fallbacks, opacityFb(29), (t) => { out.needleOpacity = asOpacity(t); });
  out.plantsColor = loadOne(scene, `${name}-veg-plants`, look.plantsColor, fallbacks, green(0.3, 0.48, 0.2, 5), (t) => { out.plantsColor = t; });
  out.plantsOpacity = loadOne(scene, `${name}-veg-plants-o`, look.plantsOpacity, fallbacks, opacityFb(7), (t) => { out.plantsOpacity = asOpacity(t); });
  out.firColor = loadOne(scene, `${name}-veg-fir`, look.firColor, fallbacks, green(0.26, 0.44, 0.18, 11), (t) => { out.firColor = t; });
  out.firOpacity = loadOne(scene, `${name}-veg-fir-o`, look.firOpacity, fallbacks, opacityFb(13), (t) => { out.firOpacity = asOpacity(t); });
  asOpacity(out.canopyOpacity);
  asOpacity(out.needleOpacity);
  asOpacity(out.plantsOpacity);
  asOpacity(out.firOpacity);
  return out;
}

// ---------------------------------------------------------------------------
// Wind sway plugin
// ---------------------------------------------------------------------------

interface SwayConfig {
  amp: number;
  freq: number;
}

const SWAY = new WeakMap<Material, SwayConfig>();

/**
 * Tiny vertex bend applied to the cutout materials (before the thin-instance
 * transform, so the offset is in plant-local space). The phase is derived from
 * the instance translation carried in the thin-instance matrix attributes
 * (world3.xyz), so every plant sways out of step.
 *
 * NOTE: `getCustomCode` runs from the MaterialPluginBase constructor before
 * subclass fields exist, so the config lives in a material-keyed registry
 * populated by `attachSway` before construction (wet-sand precedent).
 */
class FoliageSwayPlugin extends MaterialPluginBase {
  /** Simulation clock, mirrored into the effect uniform each frame. */
  public uSwayTime = 0;

  constructor(material: Material) {
    super(material, "FoliageSway", 215, { FOLIAGE_SWAY: true }, true, true);
  }

  public getClassName(): string {
    return "FoliageSway";
  }

  public bindForSubMesh(
    _uniformBuffer: UniformBuffer, _scene: unknown, _engine: unknown, _subMesh: unknown
  ): void {
    const cfg = SWAY.get(this._material);
    if (!cfg) return;
    this._material.getEffect()?.setFloat("uSwayTime", this.uSwayTime);
  }

  public getCustomCode(shaderType: string): { [point: string]: string } | null {
    const cfg = SWAY.get(this._material);
    if (!cfg) return null;
    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: `uniform float uSwayTime;`,
        CUSTOM_VERTEX_UPDATE_POSITION: `
          // Per-instance phase from the thin-instance translation.
          #ifdef INSTANCES
            float vegPhase = world3.x * 0.37 + world3.y * 0.21 + world3.z * 0.53;
          #else
            float vegPhase = 0.0;
          #endif
          #ifdef UV1
            float vegWeight = uv.y * uv.y; // bend the tops, pin the bases
          #else
            float vegWeight = 0.0;
          #endif
          float vegSway = sin(uSwayTime * ${glslNum(cfg.freq)} + vegPhase) * ${glslNum(cfg.amp)} * vegWeight;
          positionUpdated.x += vegSway;
          positionUpdated.z += vegSway * 0.55;`,
      };
    }
    return null;
  }
}

function attachSway(material: Material, cfg: SwayConfig): FoliageSwayPlugin {
  SWAY.set(material, cfg);
  return new FoliageSwayPlugin(material);
}

// ---------------------------------------------------------------------------
// Geometry helpers (single geometry per species, shared by all instances)
// ---------------------------------------------------------------------------

interface GeoAccum {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

function newGeo(): GeoAccum {
  return { positions: [], normals: [], uvs: [], indices: [] };
}

/**
 * Adds a double-sided card (quad) centred at c with local right/up axes.
 * Winding/normal follow the ground-mesh convention (indices a,c,b / b,c,d
 * with normal = cross(tx, ty)) so the base normals face outward of the card.
 */
function addCard(
  g: GeoAccum, cx: number, cy: number, cz: number,
  right: Vector3, up: Vector3, w: number, h: number
): void {
  const base = g.positions.length / 3;
  const hw = w / 2, hh = h / 2;
  const n = Vector3.Cross(right, up).normalize();
  const corners: Array<[number, number, number, number]> = [
    // [right, up, u, v]
    [-hw, -hh, 0, 0],
    [hw, -hh, 1, 0],
    [-hw, hh, 0, 1],
    [hw, hh, 1, 1],
  ];
  for (const [r, u, tu, tv] of corners) {
    g.positions.push(
      cx + right.x * r + up.x * u,
      cy + right.y * r + up.y * u,
      cz + right.z * r + up.z * u
    );
    g.normals.push(n.x, n.y, n.z);
    g.uvs.push(tu, tv);
  }
  g.indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
}

/**
 * Tapered trunk with a slight lean. Rings run top→bottom so the (a,c,b)
 * winding yields outward-facing sides (matching the ground-mesh rule with
 * tx = +angle, ty = −up). Base sits at y=0; UVs give ~2 bark wraps.
 */
function addTrunk(
  g: GeoAccum, height: number, rBottom: number, rMid: number, rTop: number,
  leanX: number, leanZ: number, sides = 7
): void {
  const rings: Array<[number, number]> = [
    [height, rTop],
    [height * 0.55, rMid],
    [0, rBottom],
  ];
  for (let iy = 0; iy < rings.length; iy++) {
    const [y, r] = rings[iy];
    const t = y / height; // 0 at base, 1 at top
    const lean = t * t;
    for (let ix = 0; ix <= sides; ix++) {
      const a = (ix / sides) * Math.PI * 2;
      const cos = Math.cos(a), sin = Math.sin(a);
      g.positions.push(cos * r + leanX * lean, y, sin * r + leanZ * lean);
      const nx = cos, nz = sin;
      const nl = Math.hypot(nx, 0.35, nz);
      g.normals.push(nx / nl, 0.35 / nl, nz / nl);
      g.uvs.push((ix / sides) * 2.0, (1 - y / height) * 1.4);
    }
  }
  for (let iy = 0; iy < rings.length - 1; iy++) {
    for (let ix = 0; ix < sides; ix++) {
      const a = iy * (sides + 1) + ix;
      const b = a + 1;
      const c = a + (sides + 1);
      const d = c + 1;
      g.indices.push(a, c, b, b, c, d);
    }
  }
}

interface SpeciesGeometry {
  meshName: string;
  geo: GeoAccum;
  material: "bark" | "plants" | "fir" | "canopy" | "needles";
}

function buildBroadleafGeometry(look: VegetationLook): SpeciesGeometry[] {
  const H = look.treeHeight;
  const trunk = newGeo();
  addTrunk(trunk, H * 0.5, H * 0.085, H * 0.055, H * 0.03, H * 0.02, H * 0.01);

  const canopy = newGeo();
  const cw = H * 0.9, ch = H * 0.72, cy = H * 0.64;
  const offsets: Array<[number, number, number]> = [
    [0.02, 0, 0], [-0.03, 0.012, 0.02], [0.04, -0.01, -0.02],
  ];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI;
    const [ox, oy, oz] = offsets[i];
    addCard(
      canopy, H * ox, cy + H * oy, H * oz,
      new Vector3(Math.cos(a), 0, Math.sin(a)), new Vector3(0, 1, 0),
      cw, ch
    );
  }
  // Horizontal crown card closes the silhouette seen from above.
  addCard(canopy, 0, cy + ch * 0.42, 0, new Vector3(1, 0, 0), new Vector3(0, 0, -1), cw * 0.8, cw * 0.8);

  return [
    { meshName: "trunk-a", geo: trunk, material: "bark" },
    { meshName: "canopy-a", geo: canopy, material: "canopy" },
  ];
}

function buildConiferGeometry(look: VegetationLook): SpeciesGeometry[] {
  const H = look.coniferHeight;
  const trunk = newGeo();
  addTrunk(trunk, H * 0.42, H * 0.07, H * 0.046, H * 0.026, H * 0.015, H * 0.008);

  const canopy = newGeo();
  const lower = [0, Math.PI / 3, (Math.PI * 2) / 3];
  for (const a of lower) {
    addCard(
      canopy, 0, H * 0.5, 0,
      new Vector3(Math.cos(a), 0, Math.sin(a)), new Vector3(0, 1, 0),
      H * 0.7, H * 0.62
    );
  }
  const upper = [Math.PI / 4, (Math.PI * 3) / 4];
  for (const a of upper) {
    addCard(
      canopy, 0, H * 0.78, 0,
      new Vector3(Math.cos(a), 0, Math.sin(a)), new Vector3(0, 1, 0),
      H * 0.46, H * 0.5
    );
  }
  return [
    { meshName: "trunk-b", geo: trunk, material: "bark" },
    { meshName: "canopy-b", geo: canopy, material: "needles" },
  ];
}

function buildShrubGeometry(look: VegetationLook): SpeciesGeometry[] {
  const H = look.shrubHeight;
  const geo = newGeo();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI;
    addCard(
      geo, 0, H * 0.45, 0,
      new Vector3(Math.cos(a), 0, Math.sin(a)), new Vector3(0, 1, 0),
      H * 1.25, H * 0.95
    );
  }
  return [{ meshName: "shrub", geo, material: "plants" }];
}

function buildGrassGeometry(look: VegetationLook): SpeciesGeometry[] {
  const H = look.grassHeight;
  const geo = newGeo();
  for (let i = 0; i < 2; i++) {
    const a = (i / 2) * Math.PI;
    addCard(
      geo, 0, H * 0.42, 0,
      new Vector3(Math.cos(a), 0, Math.sin(a)), new Vector3(0, 1, 0),
      H * 1.3, H * 0.9
    );
  }
  return [{ meshName: "grass", geo, material: "fir" }];
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

interface Placed {
  dir: Vector3;
  h: number;
}

export type VegetationLayer = "trees" | "shrubs" | "grass";

interface LayerLimits {
  line: number;
  polar: number;
  slope: number;
  shore: number;
}

/**
 * Rejection-samples `count` instance directions from `attempts` equal-area
 * candidates. `accept` returns the accept probability (0 rejects); one
 * candidate per lat-long cell keeps instances from piling up. Deterministic
 * for a given rng + terrain.
 */
function scatter(
  count: number, attempts: number, gridW: number, gridH: number,
  terrain: (x: number, y: number, z: number) => number,
  gradient: (x: number, y: number, z: number) => number,
  waterLevel: number,
  limits: LayerLimits,
  accept: (dir: Vector3, h: number) => number,
  rng: () => number
): Placed[] {
  const out: Placed[] = [];
  if (count <= 0) return out;
  const order = new Uint32Array(attempts);
  for (let i = 0; i < attempts; i++) order[i] = i;
  for (let i = attempts - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }

  const taken = new Set<number>();
  const dir = new Vector3();
  const jitter = new Vector3();
  for (let oi = 0; oi < attempts && out.length < count; oi++) {
    const i = order[oi];
    fibDir(dir, i, attempts);
    // Small noise jitter breaks up the lattice regularities.
    jitter.set(
      fbm3(dir.x * 4.1 + 3, dir.y * 4.1, dir.z * 4.1, 2, 811),
      fbm3(dir.x * 4.1, dir.y * 4.1 + 5, dir.z * 4.1, 2, 823),
      fbm3(dir.x * 4.1, dir.y * 4.1, dir.z * 4.1 + 7, 2, 837)
    );
    dir.addInPlace(jitter.scale(0.018)).normalize();

    const h = terrain(dir.x, dir.y, dir.z);
    if (h < waterLevel + limits.shore || h > limits.line) continue;
    if (Math.abs(dir.y) > limits.polar) continue;
    if (gradient(dir.x, dir.y, dir.z) > limits.slope) continue;
    const p = accept(dir, h);
    if (p <= 0 || rng() > p) continue;

    const u = Math.atan2(dir.z, dir.x) / (Math.PI * 2) + 0.5;
    const v = Math.acos(Math.max(-1, Math.min(1, dir.y))) / Math.PI;
    const cu = Math.min(gridW - 1, Math.floor(u * gridW));
    const cv = Math.min(gridH - 1, Math.floor(v * gridH));
    const key = cu + cv * gridW;
    if (taken.has(key)) continue;
    taken.add(key);
    out.push({ dir: dir.clone(), h });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public build
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

  const eps = 0.0035;
  const t1 = new Vector3(), t2 = new Vector3(), tmpDir = new Vector3();
  const upAxis = new Vector3(0, 1, 0), xAxis = new Vector3(1, 0, 0);
  const gradient = (x: number, y: number, z: number): number => {
    tmpDir.set(x, y, z).normalize();
    const ref = Math.abs(tmpDir.y) < 0.9 ? upAxis : xAxis;
    Vector3.CrossToRef(tmpDir, ref, t1);
    t1.normalize();
    Vector3.CrossToRef(t1, tmpDir, t2);
    t2.normalize();
    const ha = terrain(x + t1.x * eps, y + t1.y * eps, z + t1.z * eps);
    const hb = terrain(x - t1.x * eps, y - t1.y * eps, z - t1.z * eps);
    const hc = terrain(x + t2.x * eps, y + t2.y * eps, z + t2.z * eps);
    const hd = terrain(x - t2.x * eps, y - t2.y * eps, z - t2.z * eps);
    const g1 = (ha - hb) / (2 * eps);
    const g2 = (hc - hd) / (2 * eps);
    return Math.hypot(g1, g2);
  };

  const rng = makeRng((seed ^ 0x5bd1e995) >>> 0);

  // --- Trees: clumped woods with sparse outliers, conifers on the high ground.
  const forestAt = (dir: Vector3): number => {
    const m = fbm3(dir.x * look.forestScale + 17, dir.y * look.forestScale, dir.z * look.forestScale, 3, seed + 2100) * 0.5 + 0.5;
    return smoothstep01(look.forestLo, look.forestHi, m);
  };
  interface TreePlace extends Placed { conifer: boolean; }
  const treeLimits: LayerLimits = { line: look.treeLine, polar: look.treePolar, slope: look.treeSlope, shore: look.treeShore };
  const acceptedTrees = scatter(
    look.trees, look.trees * 10, 300, 150,
    terrain, gradient, waterLevel, treeLimits,
    (dir) => 0.12 + 0.88 * forestAt(dir),
    rng
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
    return 0.3 + 0.7 * smoothstep01(0.3, 0.66, m);
  };
  const grassMask = (dir: Vector3): number => {
    const m = fbm3(dir.x * 6.1 + 41, dir.y * 6.1, dir.z * 6.1, 2, seed + 2300) * 0.5 + 0.5;
    return 0.35 + 0.65 * smoothstep01(0.26, 0.64, m);
  };
  const shrubLimits: LayerLimits = { line: look.shrubLine, polar: look.shrubPolar, slope: look.shrubSlope, shore: look.shrubShore };
  const grassLimits: LayerLimits = { line: look.grassLine, polar: look.grassPolar, slope: look.grassSlope, shore: look.grassShore };
  const shrubs = scatter(
    look.shrubs, look.shrubs * 8, 320, 160,
    terrain, gradient, waterLevel, shrubLimits,
    (dir) => shrubMask(dir),
    rng
  );
  const grass = scatter(
    look.grass, look.grass * 6, 280, 140,
    terrain, gradient, waterLevel, grassLimits,
    (dir) => grassMask(dir),
    rng
  );

  // --- Instance matrices (body-local; the meshes are parented to the ground).
  const up = Vector3.Up();
  const alignQ = new Quaternion(), yawQ = new Quaternion(), finalQ = new Quaternion();
  const scale = new Vector3(), pos = new Vector3(), mat = new Matrix();

  const fillMatrices = (
    placed: Placed[],
    range: [number, number],
    sink: number,
    tint: Color3,
    withColors: boolean,
    footprint: number
  ): { matrices: Float32Array; colors: Float32Array | null } => {
    const n = placed.length;
    const matrices = new Float32Array(n * 16);
    const colors = withColors ? new Float32Array(n * 4) : null;
    const tA = new Vector3(), tB = new Vector3(), d2 = new Vector3();
    // Plant at the LOWEST terrain point within the instance footprint, so
    // trunks/plants sit into the ground on slopes instead of hovering over it.
    const groundH = (dir: Vector3, h: number): number => {
      if (footprint <= 0) return h;
      const ref = Math.abs(dir.y) < 0.9 ? upAxis : xAxis;
      Vector3.CrossToRef(dir, ref, tA);
      tA.normalize();
      Vector3.CrossToRef(tA, dir, tB);
      tB.normalize();
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
    bark: barkMat, plants: plantsMat, fir: firMat, canopy: canopyMat, needles: needleMat,
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
    useColors: boolean
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
    makeInstanced(part.meshName, part.geo, materials[part.material], broadleafData, broadleaf.length, part.material !== "bark");
  }
  for (const part of buildConiferGeometry(look)) {
    makeInstanced(part.meshName, part.geo, materials[part.material], coniferData, conifer.length, part.material !== "bark");
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
        textures.barkColor, textures.barkNormal,
        textures.canopyColor, textures.canopyOpacity,
        textures.needleColor, textures.needleOpacity,
        textures.plantsColor, textures.plantsOpacity,
        textures.firColor, textures.firOpacity,
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
        const x = data[i * 16 + 12], y = data[i * 16 + 13], z = data[i * 16 + 14];
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
