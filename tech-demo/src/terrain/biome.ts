/**
 * Per-vertex biome tint for terrain chunks (pure; runs in workers).
 *
 * The ground material's textures (grass/dust and rock, blended by slope and
 * altitude in the shader) carry the detail; this tint multiplies them to
 * paint the large-scale story: sandy shores, underwater shelves and deeps,
 * moisture patches, highlands and polar ice.
 */
import { fbm } from "./noise";
import { hasOcean, type TerrainShape } from "./heightField";

export type RGB = [number, number, number];

export interface BiomePalette {
  low: RGB;
  high: RGB;
  /** Multiplied where the ground is moist (forests). */
  moist: RGB;
  sand: RGB;
  shallow: RGB;
  deep: RGB;
  /** Ice-cap latitude (|dir.y|) or null. */
  iceLat: number | null;
  ice: RGB;
}

function mix(a: RGB, b: RGB, t: number, out: RGB): RGB {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

function sat(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Tint for a surface point. `h` is the terrain height (m) relative to the
 * mean radius; `slope` is 1 - n.radial.
 */
export function biomeColor(
  p: BiomePalette,
  shape: TerrainShape,
  x: number,
  y: number,
  z: number,
  h: number,
  slope: number,
  out: RGB,
): RGB {
  const sea = shape.waterLevel * shape.relief;
  const above = h - sea;
  if (hasOcean(shape) && above < 0) {
    // Under water: shallow turquoise shelf to dark deeps (seen through the
    // translucent shallows and from orbit).
    return mix(p.shallow, p.deep, sat(-above / 25), out);
  }
  const hn = h / shape.relief; // normalized height
  const moisture = fbm(x * 9 + 3, y * 9, z * 9, 3, shape.seed + 77) * 0.5 + 0.5;
  mix(p.low, p.high, sat((hn - 0.1) / 0.8), out);
  mix(
    out,
    [out[0] * p.moist[0], out[1] * p.moist[1], out[2] * p.moist[2]],
    sat((moisture - 0.45) * 2.5),
    out,
  );
  if (hasOcean(shape)) {
    // Beach band: a few meters above the waterline, narrower on steep coasts.
    const band = 2.5 * (1 - sat(slope * 6));
    const t = 1 - sat((above - band) / 2);
    mix(out, p.sand, t, out);
  }
  if (p.iceLat !== null) {
    const ice = sat((Math.abs(y) - p.iceLat) / 0.06);
    if (ice > 0) mix(out, p.ice, ice, out);
  }
  return out;
}
