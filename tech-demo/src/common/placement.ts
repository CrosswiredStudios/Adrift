/**
 * Vegetation placement kernel. Rejection-samples instance directions from
 * equal-area Fibonacci candidates with noise jitter, slope/line/polar/shore
 * gates, forest-mask acceptance, and one-per-lat-long-cell dedupe.
 * Deterministic for a given rng + terrain. Extracted from vegetation.ts
 * (Phase 2 split) so placement rules can be unit-tested without Babylon.
 */
import { Vector3 } from "@babylonjs/core";
import { fbm3 } from "./noise";
import { dirToUv, tangentBasis } from "./frames";

export interface Placed {
  dir: Vector3;
  h: number;
}

export type VegetationLayer = "trees" | "shrubs" | "grass";

export interface LayerLimits {
  line: number;
  polar: number;
  slope: number;
  shore: number;
}

/** Equal-area point `i` of `n` on the unit sphere (Fibonacci lattice). */
export function fibDir(out: Vector3, i: number, n: number): Vector3 {
  const k = i + 0.5;
  const cosT = 1 - (2 * k) / n;
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const phi = i * 2.399963229728653; // golden angle
  return out.set(sinT * Math.cos(phi), cosT, sinT * Math.sin(phi));
}

/** Finite-difference terrain gradient (normalized height per radian). */
export function makeGradient(
  terrain: (x: number, y: number, z: number) => number,
  eps = 0.0035,
): (x: number, y: number, z: number) => number {
  const t1 = new Vector3();
  const t2 = new Vector3();
  const tmp = new Vector3();
  return (x: number, y: number, z: number): number => {
    tmp.set(x, y, z).normalize();
    const { t1: b1, t2: b2 } = tangentBasis(tmp);
    t1.copyFrom(b1);
    t2.copyFrom(b2);
    const ha = terrain(x + t1.x * eps, y + t1.y * eps, z + t1.z * eps);
    const hb = terrain(x - t1.x * eps, y - t1.y * eps, z - t1.z * eps);
    const hc = terrain(x + t2.x * eps, y + t2.y * eps, z + t2.z * eps);
    const hd = terrain(x - t2.x * eps, y - t2.y * eps, z - t2.z * eps);
    const g1 = (ha - hb) / (2 * eps);
    const g2 = (hc - hd) / (2 * eps);
    return Math.hypot(g1, g2);
  };
}

/**
 * Rejection-samples `count` instance directions from `attempts` equal-area
 * candidates. `accept` returns the accept probability (0 rejects); one
 * candidate per lat-long cell keeps instances from piling up. Deterministic
 * for a given rng + terrain.
 */
export function scatter(
  count: number,
  attempts: number,
  gridW: number,
  gridH: number,
  terrain: (x: number, y: number, z: number) => number,
  gradient: (x: number, y: number, z: number) => number,
  waterLevel: number,
  limits: LayerLimits,
  accept: (dir: Vector3, h: number) => number,
  rng: () => number,
): Placed[] {
  const out: Placed[] = [];
  if (count <= 0) return out;
  const order = new Uint32Array(attempts);
  for (let i = 0; i < attempts; i++) order[i] = i;
  for (let i = attempts - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
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
      fbm3(dir.x * 4.1, dir.y * 4.1, dir.z * 4.1 + 7, 2, 837),
    );
    dir.addInPlace(jitter.scale(0.018)).normalize();

    const h = terrain(dir.x, dir.y, dir.z);
    if (h < waterLevel + limits.shore || h > limits.line) continue;
    if (Math.abs(dir.y) > limits.polar) continue;
    if (gradient(dir.x, dir.y, dir.z) > limits.slope) continue;
    const p = accept(dir, h);
    if (p <= 0 || rng() > p) continue;

    const { u, v } = dirToUv(dir);
    const cu = Math.min(gridW - 1, Math.floor(u * gridW));
    const cv = Math.min(gridH - 1, Math.floor(v * gridH));
    const key = cu + cv * gridW;
    if (taken.has(key)) continue;
    taken.add(key);
    out.push({ dir: dir.clone(), h });
  }
  return out;
}
