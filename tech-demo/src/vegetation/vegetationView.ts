/**
 * Streaming instanced vegetation for one body.
 *
 * Plants are placed per terrain cell by the workers (see
 * terrain/vegetationPlacement.ts), deterministically, so cells can be
 * generated in any order and dropped when far away. Each layer has its own
 * cell size and view radius (trees far, grass only close), and every
 * species part is one thin-instanced mesh whose instance buffer is rebuilt
 * from the active cells when the set changes.
 */
import {
  Color3,
  Material,
  Mesh,
  PBRMaterial,
  Scene,
  TransformNode,
  VertexData,
  Vector3,
} from "@babylonjs/core";
import { faceToDir, nodeArcLength, nodeKey, type NodeAddress } from "../terrain/cubeSphere";
import { clearNoDepth, markNoDepth } from "../render/sceneTargets";
import { children, roots } from "../terrain/quadtree";
import { CancelledError, type TerrainWorkerPool } from "../terrain/workerPool";
import type { VegetationCellData, VegetationRules, VegetationSpecies } from "../terrain/vegetationPlacement";
import type { TerrainShape } from "../terrain/heightField";
import { VegetationLook, defaultVegetationLook } from "./vegetationLook";
import {
  loadVegetationTextures,
  type VegetationTextures,
  mergeOpacityIntoAlbedo,
} from "./vegetationTextures";
import { FoliageSwayPlugin, attachSway } from "./foliageSway";
import {
  type GeoAccum,
  type SpeciesGeometry,
  buildBroadleafGeometry,
  buildConiferGeometry,
  buildGrassGeometry,
  buildShrubGeometry,
} from "./vegetationGeometry";

export type VegetationLayerName = "trees" | "shrubs" | "grass";

export interface LayerConfig {
  /** Cell edge length target (m). */
  cellSize: number;
  /** Cells within this distance of the camera are populated (m). */
  radius: number;
  rules: VegetationRules;
}

export interface VegetationConfig {
  trees: LayerConfig;
  shrubs: LayerConfig;
  grass: LayerConfig;
}

/** Vael's flora. Densities are per km^2 before masks. */
export const VAEL_VEGETATION: VegetationConfig = {
  trees: {
    cellSize: 200,
    radius: 900,
    rules: {
      density: 2600,
      line: 0.75,
      shore: 2.5,
      slope: 0.22,
      polar: 0.8,
      clumpFreq: 1.4,
      clumpLo: 0.42,
      clumpHi: 0.62,
      clumpFloor: 0.04,
      scale: [0.7, 1.35],
      sink: 0.25,
      tint: [1.0, 1.18, 0.85],
      coniferAbove: 0.5,
      coniferShare: 0.28,
      coniferTint: [0.95, 1.12, 0.85],
    },
  },
  shrubs: {
    cellSize: 100,
    radius: 320,
    rules: {
      density: 5000,
      line: 0.95,
      shore: 1.5,
      slope: 0.26,
      polar: 0.85,
      clumpFreq: 3,
      clumpLo: 0.35,
      clumpHi: 0.65,
      clumpFloor: 0.2,
      scale: [0.75, 1.5],
      sink: 0.15,
      tint: [1.0, 1.18, 0.85],
    },
  },
  grass: {
    cellSize: 50,
    radius: 130,
    rules: {
      density: 26000,
      line: 0.85,
      shore: 1.2,
      slope: 0.3,
      polar: 0.84,
      clumpFreq: 5,
      clumpLo: 0.3,
      clumpHi: 0.6,
      clumpFloor: 0.3,
      scale: [0.7, 1.6],
      sink: 0.08,
      tint: [0.95, 1.05, 0.7],
    },
  },
};

interface PartMesh {
  species: VegetationSpecies;
  mesh: Mesh;
  tris: number;
}

export interface VegetationStatus {
  cells: number;
  instances: Record<VegetationSpecies, number>;
  tris: number;
  pending: number;
  ready: boolean;
  fallbacks: string[];
  /** Foliage materials (of 4) that write the scene depth with a proper alpha test. */
  depthMaterials: number;
}

export class VegetationView {
  private readonly parts: PartMesh[] = [];
  /** Foliage materials whose opacity is in albedo alpha (their meshes write scene depth). */
  private readonly depthReady = new Set<PBRMaterial>();
  private readonly cells = new Map<string, VegetationCellData>();
  private readonly pending = new Set<string>();
  private readonly levels: Record<VegetationLayerName, number>;
  private dirty = false;
  private lastRebuild = 0;
  private lastSelect = 0;
  private swayTime = 0;
  private readonly sway: FoliageSwayPlugin[] = [];
  private readonly textures: VegetationTextures;
  private visible = true;
  readonly meshes: Mesh[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly bodyId: string,
    private readonly shape: TerrainShape,
    private readonly root: TransformNode,
    private readonly pool: TerrainWorkerPool,
    private readonly config: VegetationConfig = VAEL_VEGETATION,
    look: VegetationLook = defaultVegetationLook,
  ) {
    const levelFor = (size: number): number => {
      let l = 0;
      while (nodeArcLength(l, shape.radius) > size && l < 16) l++;
      return l;
    };
    this.levels = {
      trees: levelFor(config.trees.cellSize),
      shrubs: levelFor(config.shrubs.cellSize),
      grass: levelFor(config.grass.cellSize),
    };
    this.textures = loadVegetationTextures(scene, bodyId, look);
    const t = this.textures;
    const bark = new PBRMaterial(`${bodyId}-veg-bark`, scene);
    bark.albedoTexture = t.barkColor;
    bark.bumpTexture = t.barkNormal;
    bark.metallic = 0;
    bark.roughness = 0.88;
    const foliage = (label: string, color: typeof t.barkColor, opacity: typeof t.barkColor): PBRMaterial => {
      const m = new PBRMaterial(`${bodyId}-veg-${label}`, scene);
      m.albedoTexture = color;
      m.opacityTexture = opacity;
      m.transparencyMode = Material.MATERIAL_ALPHATEST;
      m.alphaCutOff = 0.45;
      m.backFaceCulling = false;
      m.twoSidedLighting = true;
      m.metallic = 0;
      m.roughness = 0.9;
      // Leaves let light through: backlit foliage glows instead of going black.
      m.subSurface.isTranslucencyEnabled = true;
      m.subSurface.translucencyIntensity = 0.8;
      m.subSurface.tintColor = new Color3(0.55, 0.75, 0.3);
      // Once both maps are in, move opacity into albedo alpha so the cards
      // can join the scene depth with a proper alpha test (see
      // mergeOpacityIntoAlbedo). Until then they stay out of it.
      void mergeOpacityIntoAlbedo(scene, `${m.name}-rgba`, color, opacity).then((merged) => {
        if (!merged || !scene.materials.includes(m)) return;
        m.albedoTexture = merged;
        m.opacityTexture = null;
        m.useAlphaFromAlbedoTexture = true;
        for (const p of this.parts) if (p.mesh.material === m) clearNoDepth(p.mesh);
        this.depthReady.add(m);
      });
      return m;
    };
    // Grass: one procedural RGBA tuft map, depth-ready from the start.
    const grassMaterial = (): PBRMaterial => {
      const m = new PBRMaterial(`${bodyId}-veg-grass`, scene);
      m.albedoTexture = t.grass;
      m.useAlphaFromAlbedoTexture = true;
      m.transparencyMode = Material.MATERIAL_ALPHATEST;
      m.alphaCutOff = 0.5;
      m.backFaceCulling = false;
      m.twoSidedLighting = true;
      m.metallic = 0;
      m.roughness = 0.85;
      m.subSurface.isTranslucencyEnabled = true;
      m.subSurface.translucencyIntensity = 0.6;
      m.subSurface.tintColor = new Color3(0.6, 0.8, 0.35);
      this.depthReady.add(m);
      return m;
    };
    const mats: Record<SpeciesGeometry["material"], PBRMaterial> = {
      bark,
      canopy: foliage("canopy", t.canopyColor, t.canopyOpacity),
      needles: foliage("needles", t.needleColor, t.needleOpacity),
      plants: foliage("plants", t.plantsColor, t.plantsOpacity),
      grass: grassMaterial(),
    };
    if (look.sway) {
      for (const m of [mats.canopy, mats.needles, mats.plants, mats.grass]) {
        this.sway.push(attachSway(m, { amp: look.swayAmp, freq: look.swayFreq }));
      }
    }
    const add = (species: VegetationSpecies, geos: SpeciesGeometry[]): void => {
      for (const g of geos) {
        const mesh = this.makeMesh(`${bodyId}-veg-${g.meshName}`, g.geo);
        mesh.material = mats[g.material];
        // Opaque bark and depth-ready foliage write the scene depth now.
        if (g.material === "bark" || this.depthReady.has(mats[g.material])) clearNoDepth(mesh);
        this.parts.push({ species, mesh, tris: g.geo.indices.length / 3 });
        this.meshes.push(mesh);
      }
    };
    add("broadleaf", buildBroadleafGeometry(look));
    add("conifer", buildConiferGeometry(look));
    add("shrub", buildShrubGeometry(look));
    add("grass", buildGrassGeometry(look));
  }

  private makeMesh(name: string, geo: GeoAccum): Mesh {
    const vd = new VertexData();
    vd.positions = geo.positions;
    vd.normals = geo.normals;
    vd.uvs = geo.uvs;
    vd.indices = geo.indices;
    const mesh = new Mesh(name, this.scene);
    vd.applyToMesh(mesh, false);
    mesh.parent = this.root;
    mesh.isPickable = false;
    mesh.thinInstanceSetBuffer("matrix", new Float32Array(16), 16, false);
    mesh.thinInstanceSetBuffer("color", new Float32Array(4), 4, false);
    mesh.thinInstanceCount = 0;
    mesh.useVertexColors = true;
    mesh.setEnabled(false);
    // Alpha-tested cards stay out of the scene depth until their opacity has
    // been merged into albedo alpha (the depth renderer alpha-tests with
    // albedo alpha only; otherwise it would write whole quads).
    markNoDepth(mesh);
    return mesh;
  }

  /** Cells of `level` within `radius` of the camera (quadtree descent). */
  private cellsNear(
    cam: Vector3,
    level: number,
    radius: number,
  ): { node: NodeAddress; key: string; d: number }[] {
    const out: { node: NodeAddress; key: string; d: number }[] = [];
    const R = this.shape.radius;
    const d3: [number, number, number] = [0, 0, 0];
    const visit = (n: NodeAddress): void => {
      const size = 2 / (1 << n.level);
      faceToDir(n.face, -1 + (n.x + 0.5) * size, -1 + (n.y + 0.5) * size, d3);
      const dist = Math.hypot(cam.x - d3[0] * R, cam.y - d3[1] * R, cam.z - d3[2] * R);
      const half = nodeArcLength(n.level, R) * 0.75 + this.shape.relief * 2;
      if (dist - half > radius) return;
      if (n.level === level) out.push({ node: n, key: nodeKey(n), d: dist });
      else for (const c of children(n)) visit(c);
    };
    for (const r of roots()) visit(r);
    return out;
  }

  /** Per-frame update (camera in the body frame; `active` = this body is being visited). */
  update(dt: number, cam: Vector3, active: boolean): void {
    this.swayTime += dt;
    for (const p of this.sway) p.uSwayTime = this.swayTime;
    const altitude = cam.length() - this.shape.radius;
    const show = active && this.visible && altitude < 1500;
    for (const p of this.parts) p.mesh.setEnabled(show && p.mesh.thinInstanceCount > 0);
    if (!show) return;

    const now = performance.now();
    if (now - this.lastSelect > 250) {
      this.lastSelect = now;
      const wanted = new Set<string>();
      for (const layer of ["trees", "shrubs", "grass"] as VegetationLayerName[]) {
        const cfg = this.config[layer];
        for (const { node, key, d } of this.cellsNear(cam, this.levels[layer], cfg.radius)) {
          const full = `${this.bodyId}:v:${layer}:${key}`;
          wanted.add(full);
          if (this.cells.has(full) || this.pending.has(full)) continue;
          this.pending.add(full);
          this.pool
            .request(
              full,
              {
                kind: "veg",
                req: { bodyId: this.bodyId, layer, rules: cfg.rules, seed: this.shape.seed, ...node },
              },
              100000 + d,
            )
            .then((r) => {
              this.pending.delete(full);
              if (r.kind === "veg") {
                this.cells.set(full, r.data);
                this.dirty = true;
              }
            })
            .catch((e) => {
              this.pending.delete(full);
              if (!(e instanceof CancelledError)) console.error(e);
            });
        }
      }
      for (const key of [...this.cells.keys()]) {
        if (!wanted.has(key)) {
          this.cells.delete(key);
          this.dirty = true;
        }
      }
      const prefix = `${this.bodyId}:v:`;
      this.pool.prune((k) => !k.startsWith(prefix) || wanted.has(k));
    }
    if (this.dirty && now - this.lastRebuild > 300) this.rebuild(now);
  }

  private rebuild(now: number): void {
    this.dirty = false;
    this.lastRebuild = now;
    const totals: Record<VegetationSpecies, number> = { broadleaf: 0, conifer: 0, shrub: 0, grass: 0 };
    for (const c of this.cells.values())
      for (const [s, v] of Object.entries(c.species)) totals[s as VegetationSpecies] += v!.count;
    const buffers = {} as Record<VegetationSpecies, { m: Float32Array; c: Float32Array; n: number }>;
    for (const s of Object.keys(totals) as VegetationSpecies[]) {
      buffers[s] = {
        m: new Float32Array(Math.max(1, totals[s]) * 16),
        c: new Float32Array(Math.max(1, totals[s]) * 4),
        n: 0,
      };
    }
    for (const cell of this.cells.values()) {
      for (const [s, v] of Object.entries(cell.species)) {
        const b = buffers[s as VegetationSpecies];
        b.m.set(v!.matrices, b.n * 16);
        b.c.set(v!.colors, b.n * 4);
        b.n += v!.count;
      }
    }
    for (const p of this.parts) {
      const b = buffers[p.species];
      p.mesh.thinInstanceSetBuffer("matrix", b.m, 16, false);
      p.mesh.thinInstanceSetBuffer("color", b.c, 4, false);
      p.mesh.thinInstanceCount = b.n;
      p.mesh.thinInstanceRefreshBoundingInfo(false);
      p.mesh.setEnabled(this.visible && b.n > 0);
    }
  }

  setVisible(on: boolean): void {
    this.visible = on;
    if (!on) for (const p of this.parts) p.mesh.setEnabled(false);
  }

  status(): VegetationStatus {
    const instances: Record<VegetationSpecies, number> = { broadleaf: 0, conifer: 0, shrub: 0, grass: 0 };
    const seen = new Set<VegetationSpecies>();
    let tris = 0;
    for (const p of this.parts) {
      if (!seen.has(p.species)) {
        instances[p.species] = p.mesh.thinInstanceCount;
        seen.add(p.species);
      }
      tris += p.tris * p.mesh.thinInstanceCount;
    }
    const t = this.textures;
    return {
      cells: this.cells.size,
      instances,
      tris,
      pending: this.pending.size,
      ready: [t.barkColor, t.canopyColor, t.canopyOpacity, t.needleColor, t.plantsColor, t.grass].every((x) =>
        x.isReady(),
      ),
      fallbacks: [...t.fallbacks],
      depthMaterials: this.depthReady.size,
    };
  }

  /** Body-frame positions of up to n instances of a species (tests). */
  sample(species: VegetationSpecies, n: number): number[][] {
    const out: number[][] = [];
    for (const c of this.cells.values()) {
      const v = c.species[species];
      if (!v) continue;
      for (let i = 0; i < v.count && out.length < n; i++) {
        out.push([v.matrices[i * 16 + 12], v.matrices[i * 16 + 13], v.matrices[i * 16 + 14]]);
      }
      if (out.length >= n) break;
    }
    return out;
  }
}
