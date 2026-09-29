/**
 * Terrain height fields: one pure function per body shape, shared by every
 * consumer that must agree on where the ground is: terrain chunk meshes
 * (built in Web Workers), collision for the ship and the player, vegetation
 * and POI placement, and the ocean's baked depth texture.
 *
 * Input is a unit direction from the body centre (body-fixed frame); output
 * is the surface height in meters relative to the mean radius. No Babylon
 * imports: this module runs inside the terrain workers.
 *
 * Shaping pipeline (planet):
 *   continents + detail + ridged mountain ranges masked to high ground
 *   -> coastal profile (gentle beach above sea level, shelf + basins below)
 *   -> small-scale relief (tens of meters down to ~2 m) for on-foot detail,
 *      damped near the waterline so it can't punch puddles into beaches.
 * Airless moons add impact craters; volcanic worlds flatten lava plains.
 */
import { fbm, perlin3, ridged, hashFloat3 } from "./noise";

/** Coastal cross-section shaping (normalized height units). */
export interface ShoresOptions {
  /** Normalized band above sea level pulled toward the waterline. */
  beachBand: number;
  /** Slope multiplier at the waterline (0.5 = twice as gentle as raw). */
  beachSlope: number;
  /** Normalized depth band below sea level flattened into a shelf. */
  shelfBand: number;
  shelfSlope: number;
  /** Extra depth multiplier applied to the deep basins. */
  deepGain: number;
}

export const defaultShores: ShoresOptions = {
  beachBand: 0.03,
  beachSlope: 0.5,
  shelfBand: 0.075,
  shelfSlope: 0.5,
  deepGain: 1.2,
};

export interface CraterOptions {
  /** Crater cells per unit-sphere unit (higher = more, smaller craters). */
  frequency: number;
  /** Probability a cell holds a crater. */
  density: number;
  /** Crater radius range as a fraction of a cell. */
  radius: [number, number];
  /** Bowl depth in meters per meter of radius. */
  depthRatio: number;
}

export interface TerrainShape {
  seed: number;
  /** Mean radius (m). */
  radius: number;
  /** Meters per normalized height unit (mountains reach ~1.2x this). */
  relief: number;
  /** Normalized sea level (terrain below is under water). Use -9 for dry worlds. */
  waterLevel: number;
  shore: ShoresOptions;
  /** Continent scale (cycles over the unit sphere). */
  continentFreq: number;
  /** Mountain range weight (0 = no ranges). */
  mountains: number;
  /** Small-scale relief amplitude in meters (hills to boulders). */
  microRelief: number;
  /** Impact craters (airless bodies). */
  craters?: CraterOptions[];
  /** Flatten lowlands into plains below this normalized height (lava fields). */
  plainsBelow?: number;
}

/** Sea surface radius (m) for a shape; mean radius when dry. */
export function seaRadius(s: TerrainShape): number {
  return s.radius + Math.max(s.waterLevel, -8) * s.relief;
}

export function hasOcean(s: TerrainShape): boolean {
  return s.waterLevel > -8;
}

function smooth01(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Large-scale normalized height before coastal shaping. */
function landform(s: TerrainShape, x: number, y: number, z: number): number {
  const seed = s.seed;
  const cf = s.continentFreq;
  const continents = fbm(x * cf + 7.1, y * cf, z * cf, 5, seed);
  const detail = fbm(x * cf * 4.1, y * cf * 4.1 + 3.3, z * cf * 4.1, 4, seed + 500);
  let h = continents * 1.25 + detail * 0.22;
  if (s.mountains > 0) {
    const rangeMask = smooth01(0.02, 0.4, continents);
    const ridge = ridged(x * cf * 2.3 + 11, y * cf * 2.3, z * cf * 2.3, 5, seed + 900);
    const crag = fbm(x * cf * 12 + 31, y * cf * 12, z * cf * 12, 3, seed + 1200);
    h += (ridge * 1.3 - 0.35 + crag * 0.15) * rangeMask * s.mountains;
  }
  // Coastline raggedness (hundreds of meters): keeps shores from being smooth arcs.
  h += fbm(x * cf * 18 + 53, y * cf * 18, z * cf * 18, 3, seed + 2300) * 0.04;
  if (s.plainsBelow !== undefined && h < s.plainsBelow) {
    // Lava plains: compress everything below the threshold toward it.
    h = s.plainsBelow - (s.plainsBelow - h) * 0.25;
  }
  return h;
}

/** Coastal profile (C1 through the waterline). */
function shapeCoast(h: number, waterLevel: number, shore: ShoresOptions): number {
  const over = h - waterLevel;
  if (over >= 0) {
    return (
      waterLevel + over - (1 - shore.beachSlope) * shore.beachBand * (1 - Math.exp(-over / shore.beachBand))
    );
  }
  const under = -over;
  const shelf = under - (1 - shore.shelfSlope) * shore.shelfBand * (1 - Math.exp(-under / shore.shelfBand));
  const basin = 1 + shore.deepGain * (1 - Math.exp(-under / (shore.shelfBand * 3)));
  return waterLevel - shelf * basin;
}

/** Crater field contribution in meters (negative bowl, raised rim). */
function craters(s: TerrainShape, x: number, y: number, z: number, c: CraterOptions, layer: number): number {
  const f = c.frequency;
  const px = x * f;
  const py = y * f;
  const pz = z * f;
  const cx = Math.floor(px);
  const cy = Math.floor(py);
  const cz = Math.floor(pz);
  const cellMeters = s.radius / f;
  let out = 0;
  const seed = s.seed + 7000 + layer * 131;
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const ix = cx + dx;
        const iy = cy + dy;
        const iz = cz + dz;
        if (hashFloat3(ix, iy, iz, seed) > c.density) continue;
        // Crater centre: random point in the cell, projected to the sphere.
        let qx = ix + hashFloat3(ix, iy, iz, seed + 1);
        let qy = iy + hashFloat3(ix, iy, iz, seed + 2);
        let qz = iz + hashFloat3(ix, iy, iz, seed + 3);
        const ql = Math.hypot(qx, qy, qz) || 1;
        qx = (qx / ql) * f;
        qy = (qy / ql) * f;
        qz = (qz / ql) * f;
        const r = c.radius[0] + (c.radius[1] - c.radius[0]) * hashFloat3(ix, iy, iz, seed + 4);
        const d = Math.hypot(px - qx, py - qy, pz - qz) / r; // 0 at centre, 1 at rim
        if (d > 1.6) continue;
        const rMeters = r * cellMeters;
        const depth = c.depthRatio * rMeters;
        // Bowl (parabola) inside, raised rim, ejecta falloff outside.
        const bowl = d < 1 ? (d * d - 1) * depth : 0;
        const rim = Math.exp(-((d - 1) * (d - 1)) / 0.04) * depth * 0.35;
        const ejecta = d > 1 ? Math.exp(-(d - 1) * 4) * depth * 0.08 : 0;
        const v = bowl + rim + ejecta;
        // Overlapping craters: the deepest bowl wins, rims add.
        out = v < 0 ? Math.min(out, v) + Math.max(0, out) * 0.3 : out + v;
      }
  return out;
}

/** Surface height (m, relative to the mean radius) along unit direction (x, y, z). */
export function terrainHeight(s: TerrainShape, x: number, y: number, z: number): number {
  const raw = landform(s, x, y, z);
  const coast = hasOcean(s) ? shapeCoast(raw, s.waterLevel, s.shore) : raw;
  let m = coast * s.relief;
  if (s.microRelief > 0) {
    // Hills (~200 m), knolls (~40 m) and ground bumps (~6 m): scale is in
    // meters, so convert to unit-sphere frequencies with the radius.
    const k = s.radius;
    const hills = fbm((x * k) / 190, (y * k) / 190, (z * k) / 190, 3, s.seed + 3100);
    const knolls = perlin3((x * k) / 37, (y * k) / 37, (z * k) / 37, s.seed + 3300);
    const bumps = perlin3((x * k) / 6.3, (y * k) / 6.3, (z * k) / 6.3, s.seed + 3500);
    let micro = hills * 0.55 + knolls * 0.3 + bumps * 0.08;
    if (hasOcean(s)) {
      // Near the waterline, damp the relief so beaches stay smooth.
      const aboveSea = m - s.waterLevel * s.relief;
      micro *= 0.15 + 0.85 * smooth01(0.5, 6, Math.abs(aboveSea));
    }
    m += micro * s.microRelief;
  }
  if (s.craters) for (let i = 0; i < s.craters.length; i++) m += craters(s, x, y, z, s.craters[i], i);
  return m;
}

/** Surface radius (m from the body centre) along a unit direction. */
export function terrainRadius(s: TerrainShape, x: number, y: number, z: number): number {
  return s.radius + terrainHeight(s, x, y, z);
}

/** Normalized height (terrain meters / relief), for biome and texture rules. */
export function normalizedHeight(s: TerrainShape, meters: number): number {
  return meters / s.relief;
}

/**
 * Terrain slope at a direction: 1 - dot(surface normal, radial). 0 = flat,
 * ~0.3 = 45 degrees. `eps` is the sampling step in meters.
 */
export function terrainSlope(s: TerrainShape, x: number, y: number, z: number, eps = 1): number {
  const n = terrainNormal(s, x, y, z, eps);
  return 1 - (n[0] * x + n[1] * y + n[2] * z);
}

/** Outward surface normal (body frame) by central differences, `eps` in meters. */
export function terrainNormal(
  s: TerrainShape,
  x: number,
  y: number,
  z: number,
  eps = 1,
): [number, number, number] {
  // Tangent basis around the direction.
  const ax = Math.abs(y) < 0.9 ? 0 : 1;
  const ay = Math.abs(y) < 0.9 ? 1 : 0;
  // t1 = dir x ref
  let t1x = y * 0 - z * ay;
  let t1y = z * ax - x * 0;
  let t1z = x * ay - y * ax;
  const l1 = Math.hypot(t1x, t1y, t1z);
  t1x /= l1;
  t1y /= l1;
  t1z /= l1;
  // t2 = dir x t1
  const t2x = y * t1z - z * t1y;
  const t2y = z * t1x - x * t1z;
  const t2z = x * t1y - y * t1x;
  const r0 = terrainRadius(s, x, y, z);
  const a = eps / r0;
  const p = (dx: number, dy: number, dz: number): [number, number, number] => {
    const l = Math.hypot(dx, dy, dz);
    const ux = dx / l;
    const uy = dy / l;
    const uz = dz / l;
    const r = terrainRadius(s, ux, uy, uz);
    return [ux * r, uy * r, uz * r];
  };
  const pa = p(x + t1x * a, y + t1y * a, z + t1z * a);
  const pb = p(x - t1x * a, y - t1y * a, z - t1z * a);
  const pc = p(x + t2x * a, y + t2y * a, z + t2z * a);
  const pd = p(x - t2x * a, y - t2y * a, z - t2z * a);
  const ux = pa[0] - pb[0];
  const uy = pa[1] - pb[1];
  const uz = pa[2] - pb[2];
  const vx = pc[0] - pd[0];
  const vy = pc[1] - pd[1];
  const vz = pc[2] - pd[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  // Orient outward.
  if (nx * x + ny * y + nz * z < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}
