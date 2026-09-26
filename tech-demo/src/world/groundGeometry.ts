import { Color3, Vector3 } from "@babylonjs/core";
import { terrainHeightNormalized } from "../common/heightField";
import type { ShoresOptions } from "../common/heightField";
import { fbm3 } from "../common/noise";
import type { TerrainLook } from "./terrainMaterial";

/**
 * Ground-mesh geometry for one planet (SRP: displaced lat-long grid +
 * normals + biome vertex colours live here; material assembly + ocean +
 * clouds + night lights live in planetSurface.ts). Extracted verbatim from
 * buildGroundGeometry so the mesh is byte-identical.
 */

export interface GroundGeometryInput {
  radius: number;
  seed: number;
  relief: number;
  segments: number;
  groundAlbedo: Color3;
  waterLevel: number;
  iceCaps: boolean;
  shore: ShoresOptions;
  terrain?: TerrainLook;
}

export interface GroundGeometry {
  positions: number[];
  normals: number[];
  colors: number[];
  indices: number[];
  uvs: number[];
  terrainUvs: number[] | null;
}

export function buildGroundGeometry(opts: GroundGeometryInput): GroundGeometry {
  const seg = opts.segments;
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const heights: number[] = [];
  // Tiled texture UVs for the terrain shader (independent of the mesh `uv`
  // pair, which stays reserved for other effects).
  const terrainUvs: number[] | null = opts.terrain ? [] : null;
  const tilesU = opts.terrain?.tilesU ?? 0;
  const tilesV = opts.terrain?.tilesV ?? 0;

  // Latitude-longitude grid sphere with FBM displacement.
  for (let iy = 0; iy <= seg; iy++) {
    const v = iy / seg;
    const theta = v * Math.PI; // 0..PI pole to pole
    const sinT = Math.sin(theta),
      cosT = Math.cos(theta);
    for (let ix = 0; ix <= seg; ix++) {
      const u = ix / seg;
      const phi = u * Math.PI * 2;
      const nx = sinT * Math.cos(phi),
        ny = cosT,
        nz = sinT * Math.sin(phi);
      const h = terrainHeightNormalized(nx, ny, nz, opts.seed, opts.waterLevel, opts.shore);
      heights.push(h);
      const r = opts.radius * (1 + h * opts.relief);
      positions.push(nx * r, ny * r, nz * r);
      uvs.push(u, 1 - v);
      if (terrainUvs) terrainUvs.push(u * tilesU, (1 - v) * tilesV);
    }
  }
  const row = seg + 1;
  for (let iy = 0; iy < seg; iy++) {
    for (let ix = 0; ix < seg; ix++) {
      const a = iy * row + ix,
        b = a + 1,
        c = a + row,
        d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  // Normals via finite differences on the height field.
  const normals: number[] = new Array(positions.length).fill(0);
  const pos = (ix: number, iy: number): Vector3 => {
    const cx = Math.min(seg, Math.max(0, ix)),
      cy = Math.min(seg, Math.max(0, iy));
    const i = (cy * row + cx) * 3;
    return new Vector3(positions[i], positions[i + 1], positions[i + 2]);
  };
  for (let iy = 0; iy <= seg; iy++) {
    for (let ix = 0; ix <= seg; ix++) {
      const p = pos(ix, iy);
      const tx = pos(ix + 1, iy).subtract(pos(ix - 1, iy));
      const ty2 = pos(ix, iy + 1).subtract(pos(ix, iy - 1));
      // Note: Babylon's left-handed winding makes (tx x ty) the outward normal here;
      // the opposite order points every terrain normal into the planet (unlit ground).
      const n = Vector3.Cross(tx, ty2);
      if (n.lengthSquared() < 1e-10) n.copyFrom(p).normalize();
      else n.normalize();
      const i = (iy * row + ix) * 3;
      normals[i] = n.x;
      normals[i + 1] = n.y;
      normals[i + 2] = n.z;
    }
  }

  // Biome vertex colors. With a terrain look attached the ground textures
  // carry the base colour, so these become a multiplicative tint: a warm band
  // along the shore, mild moisture variation inland and the strong depth
  // colours under water. Rock shading and snow caps move to the terrain shader.
  const textured = !!opts.terrain;
  const sand = textured ? new Color3(1.04, 0.98, 0.86) : new Color3(0.76, 0.66, 0.45);
  const rock = new Color3(0.42, 0.36, 0.3);
  const grass = textured ? new Color3(1, 1, 1) : opts.groundAlbedo.clone();
  const forest = textured ? new Color3(0.78, 0.9, 0.72) : grass.scale(0.55);
  const snow = new Color3(0.9, 0.92, 0.95);
  const deep = new Color3(0.1, 0.22, 0.32);
  const shallow = new Color3(0.28, 0.72, 0.74);
  for (let iy = 0; iy <= seg; iy++) {
    const v = iy / seg;
    const lat = Math.abs(v - 0.5) * 2; // 0 equator, 1 poles
    for (let ix = 0; ix <= seg; ix++) {
      const h = heights[iy * row + ix];
      const c = new Color3(0, 0, 0);
      if (h < opts.waterLevel) {
        const t = Math.min(1, (opts.waterLevel - h) / 0.3);
        c.copyFrom(Color3.Lerp(shallow, deep, t));
      } else {
        const t = Math.min(1, (h - opts.waterLevel) / 0.6);
        const moist = fbm3(ix * 0.05, iy * 0.05, 3.7, 2, opts.seed + 77) * 0.5 + 0.5;
        const veg = Color3.Lerp(grass, forest, moist);
        c.copyFrom(Color3.Lerp(sand, veg, Math.min(1, t * 2.2)));
        if (!textured && t > 0.45) c.copyFrom(Color3.Lerp(c, rock, (t - 0.45) / 0.55));
        if (!textured && opts.iceCaps && (lat > 0.82 || t > 0.85)) {
          const ice = Math.min(1, Math.max((lat - 0.82) / 0.1, (t - 0.85) / 0.1));
          c.copyFrom(Color3.Lerp(c, snow, Math.min(1, ice)));
        }
      }
      colors.push(c.r, c.g, c.b, 1);
    }
  }
  return { positions, normals, colors, indices, uvs, terrainUvs };
}
