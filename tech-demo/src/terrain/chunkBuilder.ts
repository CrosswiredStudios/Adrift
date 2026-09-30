/**
 * Terrain chunk mesh builder (pure; runs in the terrain workers).
 *
 * A chunk is one quadtree node: a (GRID+1)^2 vertex grid on its cube-face
 * square, projected to the sphere and displaced by the body's height field.
 * Positions are in the body-fixed frame (planet centred), so a chunk mesh is
 * simply parented to the body root. At this game's scale (radii of a few
 * km) float32 body-local positions are good to ~0.3 mm.
 *
 * Normals come from the height field itself (an extra ring of samples
 * around the grid), so neighbouring chunks, even at different LOD levels,
 * shade seamlessly. Cracks between LOD levels are hidden by skirts: a ring
 * of vertices hanging below each edge.
 *
 * Geomorphing: every vertex also carries the offset that takes it to where
 * the *parent* chunk's surface is (the midpoint of its even neighbours along
 * the parent's triangulation), plus the change of normal and biome colour
 * to what the parent shows there. The parent's normals are central
 * differences over *its* spacing (twice ours), so they differ from ours
 * even on shared vertices; its colours follow its slope. Morphing all three
 * means that at the switch distance the child looks exactly like the parent
 * (shape, lighting, rock/grass blend and tint), so LOD switches don't pop.
 */
import { faceToDir, nodeBounds, type NodeAddress } from "./cubeSphere";
import { terrainHeight, type TerrainShape } from "./heightField";
import { biomeColor, type BiomePalette } from "./biome";

/** Vertex attribute names of the geomorph data (see the terrain material). */
export const TERRAIN_MORPH_KIND = "terrainMorph";
export const TERRAIN_MORPH_NORMAL_KIND = "terrainMorphN";
export const TERRAIN_MORPH_COLOR_KIND = "terrainMorphC";

/** Quads per chunk side. */
export const GRID = 32;
const V = GRID + 1;
/**
 * Samples per side including the normal ring. The ring is 2 samples wide so
 * the parent's normals (central differences over 2 of our steps) can be
 * computed on every even vertex.
 */
const RING = 2;
const S = GRID + 1 + 2 * RING;

export interface ChunkRequest extends NodeAddress {
  bodyId: string;
}

export interface ChunkData {
  key: string;
  bodyId: string;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** Per vertex: offset to the parent's surface (xyz); w is set by the view (morph distance). */
  morph: Float32Array;
  /** Per vertex: normal change toward the parent's normal. */
  morphNormals: Float32Array;
  /** Per vertex: biome colour change toward the parent's colour (rgb). */
  morphColors: Float32Array;
  /** Quadtree level of the chunk. */
  level: number;
  /** Min / max surface radius over the chunk (m from the body centre). */
  minR: number;
  maxR: number;
  /** Chunk centre on the surface (body frame) for bounds + distance. */
  center: [number, number, number];
  /** Bounding-sphere radius around `center` (m). */
  boundRadius: number;
}

let sharedIndices: Uint32Array | null = null;

/**
 * Index buffer shared by every chunk: the grid plus 4 skirt strips.
 * Winding: Babylon treats triangles as front-facing when
 * cross(p1 - p0, p2 - p0) points away from the viewer; for a face grid with
 * a x b = outward normal that is (i,j) -> (i,j+1) -> (i+1,j).
 */
export function chunkIndices(): Uint32Array {
  if (sharedIndices) return sharedIndices;
  const idx: number[] = [];
  const at = (i: number, j: number): number => j * V + i;
  for (let j = 0; j < GRID; j++)
    for (let i = 0; i < GRID; i++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i, j + 1);
      const d = at(i + 1, j + 1);
      idx.push(a, c, b, b, c, d);
    }
  // Skirts: edge vertex e_k and its dropped copy s_k. A crack can be seen
  // from either side of the edge, so each skirt quad is emitted with both
  // windings (the terrain material keeps back-face culling on).
  const base = V * V;
  const edges: number[][] = [
    Array.from({ length: V }, (_, i) => at(i, 0)), // v = v0
    Array.from({ length: V }, (_, j) => at(GRID, j)), // u = u1
    Array.from({ length: V }, (_, i) => at(GRID - i, GRID)), // v = v1
    Array.from({ length: V }, (_, j) => at(0, GRID - j)), // u = u0
  ];
  edges.forEach((edge, e) => {
    for (let k = 0; k < V - 1; k++) {
      const a = edge[k];
      const b = edge[k + 1];
      const sa = base + e * V + k;
      const sb = base + e * V + k + 1;
      idx.push(a, sa, b, b, sa, sb);
      idx.push(a, b, sa, b, sb, sa);
    }
  });
  sharedIndices = new Uint32Array(idx);
  return sharedIndices;
}

/** Total vertices per chunk (grid + 4 skirt rows). */
export const CHUNK_VERTS = V * V + 4 * V;

export interface ChunkContext {
  shape: TerrainShape;
  palette: BiomePalette;
}

/** Build the vertex data for one chunk. */
export function buildChunk(req: ChunkRequest, ctx: ChunkContext, key: string): ChunkData {
  const { shape, palette } = ctx;
  const { u0, v0, size } = nodeBounds(req);
  const step = size / GRID;
  const R = shape.radius;

  // Sample grid incl. a RING-sample ring for normals: sample (i, j) for
  // i, j in [-RING, GRID + RING].
  const sx = new Float64Array(S * S);
  const sy = new Float64Array(S * S);
  const sz = new Float64Array(S * S);
  const sh = new Float64Array(S * S);
  const d: [number, number, number] = [0, 0, 0];
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const u = u0 + (i - RING) * step;
      const v = v0 + (j - RING) * step;
      faceToDir(req.face, u, v, d);
      const h = terrainHeight(shape, d[0], d[1], d[2]);
      const r = R + h;
      const k = j * S + i;
      sx[k] = d[0] * r;
      sy[k] = d[1] * r;
      sz[k] = d[2] * r;
      sh[k] = h;
    }
  }

  // Normal at sample k from central differences `stride` samples apart
  // (1 = our spacing, 2 = the parent's). a x b is outward for every face
  // (see cubeSphere FACES).
  const sampleNormal = (k: number, stride: number, out: [number, number, number]): void => {
    const kr = k + stride;
    const kl = k - stride;
    const ku = k + stride * S;
    const kd = k - stride * S;
    const ax = sx[kr] - sx[kl];
    const ay = sy[kr] - sy[kl];
    const az = sz[kr] - sz[kl];
    const bx = sx[ku] - sx[kd];
    const by = sy[ku] - sy[kd];
    const bz = sz[ku] - sz[kd];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    out[0] = nx / nl;
    out[1] = ny / nl;
    out[2] = nz / nl;
  };

  const positions = new Float32Array(CHUNK_VERTS * 3);
  const normals = new Float32Array(CHUNK_VERTS * 3);
  const colors = new Float32Array(CHUNK_VERTS * 4);
  let minR = Infinity;
  let maxR = -Infinity;
  const col: [number, number, number] = [0, 0, 0];
  const nrm: [number, number, number] = [0, 0, 0];

  for (let j = 0; j < V; j++) {
    for (let i = 0; i < V; i++) {
      const k = (j + RING) * S + (i + RING);
      const o = j * V + i;
      const px = sx[k];
      const py = sy[k];
      const pz = sz[k];
      positions[o * 3] = px;
      positions[o * 3 + 1] = py;
      positions[o * 3 + 2] = pz;
      sampleNormal(k, 1, nrm);
      const [nx, ny, nz] = nrm;
      normals[o * 3] = nx;
      normals[o * 3 + 1] = ny;
      normals[o * 3 + 2] = nz;
      const r = Math.hypot(px, py, pz);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      // Slope: 1 - n . radial
      const slope = 1 - (nx * px + ny * py + nz * pz) / r;
      biomeColor(palette, shape, px / r, py / r, pz / r, sh[k], slope, col);
      colors[o * 4] = col[0];
      colors[o * 4 + 1] = col[1];
      colors[o * 4 + 2] = col[2];
      colors[o * 4 + 3] = 1;
    }
  }

  // Geomorph targets (level 0 has no parent: all zero).
  const morph = new Float32Array(CHUNK_VERTS * 4);
  const morphNormals = new Float32Array(CHUNK_VERTS * 3);
  const morphColors = new Float32Array(CHUNK_VERTS * 3);
  if (req.level > 0) {
    const at = (ii: number, jj: number): number => jj * V + ii;
    // What the parent shows on the shared (even) vertices: its normal (over
    // its own spacing) and the biome colour for that normal's slope.
    const pN = new Float32Array(V * V * 3);
    const pC = new Float32Array(V * V * 3);
    for (let j = 0; j < V; j += 2) {
      for (let i = 0; i < V; i += 2) {
        const k = (j + RING) * S + (i + RING);
        const o = at(i, j);
        sampleNormal(k, 2, nrm);
        const px = sx[k];
        const py = sy[k];
        const pz = sz[k];
        const r = Math.hypot(px, py, pz);
        const slope = 1 - (nrm[0] * px + nrm[1] * py + nrm[2] * pz) / r;
        biomeColor(palette, shape, px / r, py / r, pz / r, sh[k], slope, col);
        for (let c = 0; c < 3; c++) {
          pN[o * 3 + c] = nrm[c];
          pC[o * 3 + c] = col[c];
        }
      }
    }
    // Targets: the parent's values on even vertices, and the linear
    // interpolation along the parent's triangle edge on odd ones (what the
    // rasteriser does across the parent's triangles).
    const tgt = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const mid = (a: number, b: number): void => {
      for (let c = 0; c < 3; c++) {
        tgt[c] = (positions[a * 3 + c] + positions[b * 3 + c]) / 2;
        tgt[3 + c] = pN[a * 3 + c] + pN[b * 3 + c];
        tgt[6 + c] = (pC[a * 3 + c] + pC[b * 3 + c]) / 2;
      }
      const l = Math.hypot(tgt[3], tgt[4], tgt[5]) || 1;
      tgt[3] /= l;
      tgt[4] /= l;
      tgt[5] /= l;
    };
    for (let j = 0; j < V; j++) {
      for (let i = 0; i < V; i++) {
        const oddI = i & 1;
        const oddJ = j & 1;
        const o = at(i, j);
        if (!oddI && !oddJ) {
          for (let c = 0; c < 3; c++) {
            tgt[c] = positions[o * 3 + c];
            tgt[3 + c] = pN[o * 3 + c];
            tgt[6 + c] = pC[o * 3 + c];
          }
        } else if (oddI && !oddJ) mid(at(i - 1, j), at(i + 1, j));
        else if (!oddI && oddJ) mid(at(i, j - 1), at(i, j + 1));
        else mid(at(i + 1, j - 1), at(i - 1, j + 1)); // the parent quad's diagonal
        for (let c = 0; c < 3; c++) {
          morph[o * 4 + c] = tgt[c] - positions[o * 3 + c];
          morphNormals[o * 3 + c] = tgt[3 + c] - normals[o * 3 + c];
          morphColors[o * 3 + c] = tgt[6 + c] - colors[o * 4 + c];
        }
      }
    }
  }

  // Skirts: copy the edge vertex, pulled toward the centre.
  const skirtDepth = Math.max(1.5, size * R * 0.02);
  const edgeIndex = (e: number, k: number): number => {
    switch (e) {
      case 0:
        return k; // (k, 0)
      case 1:
        return k * V + GRID; // (GRID, k)
      case 2:
        return GRID * V + (GRID - k); // (GRID - k, GRID)
      default:
        return (GRID - k) * V; // (0, GRID - k)
    }
  };
  for (let e = 0; e < 4; e++) {
    for (let k = 0; k < V; k++) {
      const src = edgeIndex(e, k);
      const dst = V * V + e * V + k;
      const px = positions[src * 3];
      const py = positions[src * 3 + 1];
      const pz = positions[src * 3 + 2];
      const r = Math.hypot(px, py, pz);
      const s = (r - skirtDepth) / r;
      positions[dst * 3] = px * s;
      positions[dst * 3 + 1] = py * s;
      positions[dst * 3 + 2] = pz * s;
      normals[dst * 3] = normals[src * 3];
      normals[dst * 3 + 1] = normals[src * 3 + 1];
      normals[dst * 3 + 2] = normals[src * 3 + 2];
      for (let c = 0; c < 4; c++) colors[dst * 4 + c] = colors[src * 4 + c];
      for (let c = 0; c < 4; c++) morph[dst * 4 + c] = morph[src * 4 + c];
      for (let c = 0; c < 3; c++) morphNormals[dst * 3 + c] = morphNormals[src * 3 + c];
      for (let c = 0; c < 3; c++) morphColors[dst * 3 + c] = morphColors[src * 3 + c];
    }
  }

  // Bounds: centre direction of the node at mid height, radius to cover corners.
  faceToDir(req.face, u0 + size / 2, v0 + size / 2, d);
  const midR = (minR + maxR) / 2;
  const center: [number, number, number] = [d[0] * midR, d[1] * midR, d[2] * midR];
  let boundRadius = 0;
  for (let o = 0; o < V * V; o++) {
    const dx = positions[o * 3] - center[0];
    const dy = positions[o * 3 + 1] - center[1];
    const dz = positions[o * 3 + 2] - center[2];
    boundRadius = Math.max(boundRadius, dx * dx + dy * dy + dz * dz);
  }
  boundRadius = Math.sqrt(boundRadius);

  return {
    key,
    bodyId: req.bodyId,
    positions,
    normals,
    colors,
    morph,
    morphNormals,
    morphColors,
    level: req.level,
    minR,
    maxR,
    center,
    boundRadius,
  };
}
