/**
 * Terrain job handlers shared by the Web Worker and the synchronous
 * fallback (tests, environments without workers). Pure: no DOM, no Babylon.
 */
import { buildChunk, type ChunkData, type ChunkRequest, type ChunkContext } from "./chunkBuilder";
import { nodeKey } from "./cubeSphere";
import { terrainHeight, type TerrainShape } from "./heightField";
import type { BiomePalette } from "./biome";
import { placeVegetation, type VegetationCellRequest, type VegetationCellData } from "./vegetationPlacement";

export interface BodyTerrainInit {
  shape: TerrainShape;
  palette: BiomePalette;
}

export type JobRequest =
  | { kind: "init"; bodies: Record<string, BodyTerrainInit> }
  | { kind: "chunk"; req: ChunkRequest }
  | { kind: "bake"; bodyId: string; width: number; height: number; row0: number; rows: number }
  | { kind: "veg"; req: VegetationCellRequest };

export type JobResult =
  | { kind: "init" }
  | { kind: "chunk"; data: ChunkData }
  | {
      kind: "bake";
      bodyId: string;
      width: number;
      height: number;
      row0: number;
      rows: number;
      data: Uint8Array;
    }
  | { kind: "veg"; data: VegetationCellData };

const contexts = new Map<string, ChunkContext>();

/** Height-map encoding range (m): value = (h - BAKE_MIN) / BAKE_RANGE as 16 bit. */
export const BAKE_MIN = -400;
export const BAKE_RANGE = 800;

export function runJob(job: JobRequest): { result: JobResult; transfer: ArrayBuffer[] } {
  switch (job.kind) {
    case "init": {
      for (const [id, b] of Object.entries(job.bodies))
        contexts.set(id, { shape: b.shape, palette: b.palette });
      return { result: { kind: "init" }, transfer: [] };
    }
    case "chunk": {
      const ctx = contexts.get(job.req.bodyId);
      if (!ctx) throw new Error(`terrain: body ${job.req.bodyId} not initialised`);
      const data = buildChunk(job.req, ctx, `${job.req.bodyId}:${nodeKey(job.req)}`);
      return {
        result: { kind: "chunk", data },
        transfer: [
          data.positions.buffer as ArrayBuffer,
          data.normals.buffer as ArrayBuffer,
          data.colors.buffer as ArrayBuffer,
          data.morph.buffer as ArrayBuffer,
          data.morphNormals.buffer as ArrayBuffer,
        ],
      };
    }
    case "bake": {
      const ctx = contexts.get(job.bodyId);
      if (!ctx) throw new Error(`terrain: body ${job.bodyId} not initialised`);
      const data = bakeHeightMap(ctx.shape, job.width, job.height, job.row0, job.rows);
      return {
        result: {
          kind: "bake",
          bodyId: job.bodyId,
          width: job.width,
          height: job.height,
          row0: job.row0,
          rows: job.rows,
          data,
        },
        transfer: [data.buffer as ArrayBuffer],
      };
    }
    case "veg": {
      const ctx = contexts.get(job.req.bodyId);
      if (!ctx) throw new Error(`terrain: body ${job.req.bodyId} not initialised`);
      const data = placeVegetation(job.req, ctx.shape);
      return {
        result: { kind: "veg", data },
        transfer: [data.matrices.buffer as ArrayBuffer, data.colors.buffer as ArrayBuffer],
      };
    }
  }
}

/**
 * Lat-long height map (meters, 16-bit fixed point in RG) for shaders that
 * need to know the terrain under a point (ocean depth, shore direction).
 * u = atan2(z, x) / 2pi + 0.5, v = acos(y) / pi, matching DIR_TO_UV_GLSL in
 * common/frames.ts. Baked in strips of rows so the job never blocks a
 * worker for long (terrain chunks interleave with it).
 */
export function bakeHeightMap(
  shape: TerrainShape,
  width: number,
  height: number,
  row0 = 0,
  rows = height,
): Uint8Array {
  const data = new Uint8Array(width * rows * 4);
  for (let iy = row0; iy < row0 + rows; iy++) {
    const theta = ((iy + 0.5) / height) * Math.PI;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    for (let ix = 0; ix < width; ix++) {
      const phi = ((ix + 0.5) / width - 0.5) * Math.PI * 2;
      const x = sinT * Math.cos(phi);
      const y = cosT;
      const z = sinT * Math.sin(phi);
      const h = terrainHeight(shape, x, y, z);
      const q = Math.max(0, Math.min(65535, Math.round(((h - BAKE_MIN) / BAKE_RANGE) * 65535)));
      const o = ((iy - row0) * width + ix) * 4;
      data[o] = q >> 8;
      data[o + 1] = q & 255;
      data[o + 2] = 0;
      data[o + 3] = 255;
    }
  }
  return data;
}
