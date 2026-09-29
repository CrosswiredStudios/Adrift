/**
 * Deterministic vegetation placement per terrain cell (pure; runs in the
 * terrain workers).
 *
 * The planet surface is divided into cube-sphere quadtree cells at a fixed
 * level (~100 m). Each cell's plants depend only on (body seed, cell, layer),
 * so a cell can be generated in any order, thrown away and regenerated
 * identically: the streamer only keeps cells near the camera.
 *
 * Output: Babylon-layout instance matrices (row-major, translation in
 * 12..14) in the body frame, plus per-instance tints.
 */
import { faceToDir, nodeBounds, type NodeAddress } from "./cubeSphere";
import { hasOcean, terrainHeight, terrainNormal, type TerrainShape } from "./heightField";
import { fbm } from "./noise";

export type VegetationSpecies = "broadleaf" | "conifer" | "shrub" | "grass";

export interface VegetationRules {
  /** Instances per km^2 before masks (upper bound). */
  density: number;
  /** Normalized-height ceiling (tree line). */
  line: number;
  /** Minimum height above sea level (m). */
  shore: number;
  /** Max slope (1 - n.radial). */
  slope: number;
  /** Reject |dir.y| above this (polar caps). */
  polar: number;
  /** Clumping noise: frequency (per km) and acceptance window. */
  clumpFreq: number;
  clumpLo: number;
  clumpHi: number;
  /** Floor acceptance outside clumps (0 = only inside clumps). */
  clumpFloor: number;
  /** Uniform scale range. */
  scale: [number, number];
  /** Sink into the ground (m) so bases never float. */
  sink: number;
  /** Instance tint (multiplied with the texture) and random shade range. */
  tint: [number, number, number];
  /** Conifer split for tree layers: above this normalized height, or by noise. */
  coniferAbove?: number;
  coniferShare?: number;
  coniferTint?: [number, number, number];
}

export interface VegetationCellRequest extends NodeAddress {
  bodyId: string;
  layer: "trees" | "shrubs" | "grass";
  rules: VegetationRules;
  seed: number;
}

export interface SpeciesInstances {
  matrices: Float32Array;
  colors: Float32Array;
  count: number;
}

export interface VegetationCellData {
  key: string;
  bodyId: string;
  layer: "trees" | "shrubs" | "grass";
  /** Concatenated: species index per instance selects the output mesh. */
  species: Partial<Record<VegetationSpecies, SpeciesInstances>>;
  /** For transfer lists: all arrays of all species, in one buffer each. */
  matrices: Float32Array;
  colors: Float32Array;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function vegetationCellKey(r: VegetationCellRequest): string {
  return `${r.bodyId}:${r.layer}:${r.face}/${r.level}/${r.x}/${r.y}`;
}

/** Place one layer's instances in one cell. */
export function placeVegetation(req: VegetationCellRequest, shape: TerrainShape): VegetationCellData {
  const { rules } = req;
  const R = shape.radius;
  const { u0, v0, size } = nodeBounds(req);
  // Cell area (approx) from its arc length.
  const edge = ((Math.PI / 2) * R) / (1 << req.level);
  const areaKm2 = (edge * edge) / 1e6;
  const candidates = Math.max(0, Math.round(rules.density * areaKm2));
  const salt = req.layer === "trees" ? 11 : req.layer === "shrubs" ? 23 : 37;
  const rng = mulberry32(
    (req.seed * 73856093) ^
      (req.face * 19349663) ^
      (req.level * 83492791) ^
      (req.x * 2654435761) ^
      (req.y * 97531) ^
      salt,
  );
  const sea = hasOcean(shape) ? shape.waterLevel * shape.relief : -Infinity;
  const buckets: Record<VegetationSpecies, number[][]> = { broadleaf: [], conifer: [], shrub: [], grass: [] };
  const d: [number, number, number] = [0, 0, 0];

  // Jittered grid: candidates spread evenly, then randomly offset in-cell.
  const side = Math.max(1, Math.ceil(Math.sqrt(candidates)));
  for (let gj = 0; gj < side; gj++) {
    for (let gi = 0; gi < side; gi++) {
      if (gj * side + gi >= candidates) break;
      const u = u0 + ((gi + rng()) / side) * size;
      const v = v0 + ((gj + rng()) / side) * size;
      faceToDir(req.face, u, v, d);
      const [x, y, z] = d;
      const r1 = rng();
      const r2 = rng();
      const r3 = rng();
      const r4 = rng();
      if (Math.abs(y) > rules.polar) continue;
      const h = terrainHeight(shape, x, y, z);
      if (h - sea < rules.shore) continue;
      if (h / shape.relief > rules.line) continue;
      const n = terrainNormal(shape, x, y, z, 1.5);
      const slope = 1 - (n[0] * x + n[1] * y + n[2] * z);
      if (slope > rules.slope) continue;
      const k = rules.clumpFreq * (R / 1000);
      const clump = fbm(x * k + 17, y * k, z * k, 3, shape.seed + salt * 101) * 0.5 + 0.5;
      const accept = rules.clumpFloor + (1 - rules.clumpFloor) * smooth(rules.clumpLo, rules.clumpHi, clump);
      if (r1 > accept) continue;

      let species: VegetationSpecies;
      if (req.layer === "trees") {
        const cold = rules.coniferAbove !== undefined && h / shape.relief > rules.coniferAbove;
        const pick = fbm(x * k * 3 + 5, y * k * 3, z * k * 3, 2, shape.seed + 2400) * 0.5 + 0.5;
        species = cold || pick < (rules.coniferShare ?? 0) ? "conifer" : "broadleaf";
      } else species = req.layer === "shrubs" ? "shrub" : "grass";

      // Plant at the lowest ground within ~1 m so trunks don't hover on slopes.
      const s = rules.scale[0] + (rules.scale[1] - rules.scale[0]) * r2;
      const baseR = R + h - rules.sink - slope * 1.5;
      const tint = species === "conifer" && rules.coniferTint ? rules.coniferTint : rules.tint;
      const shade = 0.78 + 0.42 * r3;
      const yaw = r4 * Math.PI * 2;
      buckets[species].push([
        x,
        y,
        z,
        baseR,
        s,
        s * (0.85 + 0.35 * r2),
        yaw,
        tint[0] * shade,
        tint[1] * shade,
        tint[2] * shade,
      ]);
    }
  }

  let total = 0;
  for (const b of Object.values(buckets)) total += b.length;
  const matrices = new Float32Array(total * 16);
  const colors = new Float32Array(total * 4);
  const species: Partial<Record<VegetationSpecies, SpeciesInstances>> = {};
  let offset = 0;
  for (const name of Object.keys(buckets) as VegetationSpecies[]) {
    const list = buckets[name];
    if (!list.length) continue;
    const m = matrices.subarray(offset * 16, (offset + list.length) * 16);
    const c = colors.subarray(offset * 4, (offset + list.length) * 4);
    list.forEach((p, i) => {
      writeInstance(m, i * 16, p[0], p[1], p[2], p[3], p[4], p[5], p[6]);
      c[i * 4] = p[7];
      c[i * 4 + 1] = p[8];
      c[i * 4 + 2] = p[9];
      c[i * 4 + 3] = 1;
    });
    species[name] = { matrices: m, colors: c, count: list.length };
    offset += list.length;
  }
  return { key: vegetationCellKey(req), bodyId: req.bodyId, layer: req.layer, species, matrices, colors };
}

/**
 * Babylon row-major world matrix for a plant: local Y along the radial
 * direction (plants grow straight up), random yaw, non-uniform scale,
 * translation at radius `r` along (x, y, z).
 */
function writeInstance(
  out: Float32Array,
  o: number,
  x: number,
  y: number,
  z: number,
  r: number,
  s: number,
  sy: number,
  yaw: number,
): void {
  // Tangent basis around up = (x, y, z).
  const refY = Math.abs(y) < 0.9;
  const rx = refY ? 0 : 1;
  const ry = refY ? 1 : 0;
  // t1 = normalize(up x ref)
  let t1x = y * 0 - z * ry;
  let t1y = z * rx - x * 0;
  let t1z = x * ry - y * rx;
  const l = Math.hypot(t1x, t1y, t1z);
  t1x /= l;
  t1y /= l;
  t1z /= l;
  // t2 = up x t1
  const t2x = y * t1z - z * t1y;
  const t2y = z * t1x - x * t1z;
  const t2z = x * t1y - y * t1x;
  const c = Math.cos(yaw);
  const sn = Math.sin(yaw);
  // Local X axis (yawed), local Y = up, local Z = X x Y (same handedness as identity).
  const ax = t1x * c + t2x * sn;
  const ay = t1y * c + t2y * sn;
  const az = t1z * c + t2z * sn;
  const zx = ay * z - az * y;
  const zy = az * x - ax * z;
  const zz = ax * y - ay * x;
  out[o] = ax * s;
  out[o + 1] = ay * s;
  out[o + 2] = az * s;
  out[o + 3] = 0;
  out[o + 4] = x * sy;
  out[o + 5] = y * sy;
  out[o + 6] = z * sy;
  out[o + 7] = 0;
  out[o + 8] = zx * s;
  out[o + 9] = zy * s;
  out[o + 10] = zz * s;
  out[o + 11] = 0;
  out[o + 12] = x * r;
  out[o + 13] = y * r;
  out[o + 14] = z * r;
  out[o + 15] = 1;
}
