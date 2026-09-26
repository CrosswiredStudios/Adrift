/**
 * Terrain height field. Single home for the normalized-height formula that
 * the ground mesh, the baked ocean height texture, flight collision, and
 * vegetation placement must all agree on. Extracted from planetSurface.ts
 * so the CPU/GPU contract has one owner and unit tests can pin it.
 */
import { fbm3 } from "./noise";
import { smoothstep } from "./math";

/**
 * Coastal cross-section shaping. The raw FBM terrain meets the sea at whatever
 * slope it happens to have (mostly cliffs); these parameters carve a gentle
 * beach band above sea level, a shallow shelf below it and deeper basins
 * further out, so waves can shoal, break and run up.
 */
export interface ShoresOptions {
  /** Normalized height band above sea level pulled toward the waterline. */
  beachBand: number;
  /** Slope multiplier right at the waterline (0.35 = ~3x gentler than raw). */
  beachSlope: number;
  /** Normalized depth band below sea level flattened into a shallow shelf. */
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

/**
 * Normalized terrain height (same formula the ground mesh is displaced by).
 * Shared by the mesh builder, the ocean shader's baked height field and
 * CPU-side flight collision (see planets.ts `surfaceRadius`) so the visible
 * surface, the water and the flight model never disagree.
 *
 * Landforms are continent + detail FBM, plus a ridged term that only grows
 * where the continents term is high, so crests cluster into mountain ranges
 * with craggy flanks instead of speckling every landmass uniformly.
 */
export function terrainHeightNormalized(
  nx: number,
  ny: number,
  nz: number,
  seed: number,
  waterLevel: number,
  shore: ShoresOptions = defaultShores,
): number {
  const continents = fbm3(nx * 2.2 + 7, ny * 2.2, nz * 2.2, 5, seed);
  const detail = fbm3(nx * 9, ny * 9 + 3, nz * 9, 4, seed + 500);
  const rangeMask = smoothstep(0.05, 0.45, continents);
  const ridged = 1 - Math.abs(fbm3(nx * 5 + 11, ny * 5, nz * 5, 4, seed + 900));
  // Coarse crags on the range flanks (~145 world units wavelength on Vael at
  // 26 cycles per unit sphere — still resolvable by the 192-segment grid).
  const crag = fbm3(nx * 26 + 31, ny * 26, nz * 26, 3, seed + 1200);
  // Fine roughness everywhere (unmasked): keeps coastal plains from sitting
  // flat to within wave height of the waterline, where the sea would sheet
  // foam over ground that reads as land. ~94 world units wavelength on Vael,
  // roughly half a unit of relief — enough to ragged the waterline into a
  // land/water mosaic.
  const roughness = fbm3(nx * 40 + 53, ny * 40, nz * 40, 3, seed + 2300);
  const h =
    continents * 0.85 + detail * 0.16 + ((ridged - 0.45) * 1.1 + crag * 0.12) * rangeMask + roughness * 0.02;

  // Coastal shaping (C1-continuous through the waterline so normals stay smooth).
  const over = h - waterLevel;
  if (over >= 0) {
    // Beach: slope ramps from `beachSlope` at the waterline to 1 inland.
    return (
      waterLevel + over - (1 - shore.beachSlope) * shore.beachBand * (1 - Math.exp(-over / shore.beachBand))
    );
  }
  // Shelf: gentle right below the waterline, then basins deepen with distance.
  const under = -over;
  const shelf = under - (1 - shore.shelfSlope) * shore.shelfBand * (1 - Math.exp(-under / shore.shelfBand));
  const basin = 1 + shore.deepGain * (1 - Math.exp(-under / (shore.shelfBand * 3)));
  return waterLevel - shelf * basin;
}
