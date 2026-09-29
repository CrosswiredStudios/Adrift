import { describe, expect, it } from "vitest";
import { fbm, hash32, perlin3 } from "./noise";
import { FACES, dirToFaceUv, faceToDir, levelForSpacing, nodeArcLength } from "./cubeSphere";
import { defaultShores, terrainHeight, terrainNormal, seaRadius, type TerrainShape } from "./heightField";
import { buildChunk, chunkIndices, CHUNK_VERTS, GRID } from "./chunkBuilder";
import { resolveDrawSet, selectLeaves, roots, children } from "./quadtree";
import { placeVegetation } from "./vegetationPlacement";
import type { BiomePalette } from "./biome";

const shape: TerrainShape = {
  seed: 1337,
  radius: 2000,
  relief: 95,
  waterLevel: -0.08,
  shore: defaultShores,
  continentFreq: 2.2,
  mountains: 1,
  microRelief: 3.5,
};
const palette: BiomePalette = {
  low: [1, 1, 1],
  high: [0.8, 0.9, 0.7],
  moist: [0.8, 0.9, 0.7],
  sand: [1, 0.95, 0.8],
  shallow: [0.3, 0.7, 0.7],
  deep: [0.1, 0.2, 0.3],
  iceLat: 0.86,
  ice: [0.9, 0.92, 0.95],
};

describe("noise", () => {
  it("hash32 matches reference values and is uint32", () => {
    expect(hash32(0)).toBe(0);
    expect(hash32(1)).toBe(hash32(1));
    expect(hash32(1)).not.toBe(hash32(2));
    expect(hash32(0xffffffff)).toBeGreaterThanOrEqual(0);
    expect(hash32(-1)).toBe(hash32(0xffffffff));
  });

  it("perlin is continuous, zero on lattice points and bounded", () => {
    expect(perlin3(3, 4, 5, 9)).toBe(0);
    let max = 0;
    for (let i = 0; i < 2000; i++) {
      const v = perlin3(i * 0.137, i * 0.071, i * 0.293, 5);
      max = Math.max(max, Math.abs(v));
      const w = perlin3(i * 0.137 + 1e-6, i * 0.071, i * 0.293, 5);
      expect(Math.abs(v - w)).toBeLessThan(1e-4);
    }
    expect(max).toBeLessThan(1.1);
    expect(max).toBeGreaterThan(0.3);
    expect(Math.abs(fbm(0.3, 0.2, 0.1, 5, 1))).toBeLessThan(1);
  });
});

describe("cube sphere", () => {
  it("face tangents are right-handed with the outward normal", () => {
    for (const f of FACES) {
      const [ax, ay, az] = f.a;
      const [bx, by, bz] = f.b;
      const c = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
      expect(c).toEqual(f.n.map((v) => v + 0)); // -0 safe compare
    }
  });

  it("maps face coordinates to unit directions and back", () => {
    const d: [number, number, number] = [0, 0, 0];
    for (let face = 0; face < 6; face++) {
      for (const [u, v] of [
        [0, 0],
        [0.7, -0.3],
        [-0.95, 0.95],
      ]) {
        faceToDir(face, u, v, d);
        expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 12);
        const back = dirToFaceUv(d[0], d[1], d[2]);
        expect(back.face).toBe(face);
        expect(back.u).toBeCloseTo(u, 6);
        expect(back.v).toBeCloseTo(v, 6);
      }
    }
  });

  it("face edges meet exactly (seamless cube)", () => {
    // +X face at u = -1 (a = -Z side... ) must coincide with some other face edge.
    const a: [number, number, number] = [0, 0, 0];
    faceToDir(0, 1, 0.3, a);
    const back = dirToFaceUv(a[0], a[1], a[2]);
    const b: [number, number, number] = [0, 0, 0];
    faceToDir(back.face, back.u, back.v, b);
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(1e-9);
  });

  it("picks a leaf level with sub-meter spacing on Vael", () => {
    const level = levelForSpacing(2000, GRID, 0.8);
    expect(nodeArcLength(level, 2000) / GRID).toBeLessThanOrEqual(0.8);
    expect(level).toBe(7);
  });
});

describe("height field", () => {
  it("is deterministic and within the relief envelope", () => {
    let min = Infinity;
    let max = -Infinity;
    const d: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 400; i++) {
      faceToDir(i % 6, ((i * 37) % 100) / 50 - 1, ((i * 91) % 100) / 50 - 1, d);
      const h = terrainHeight(shape, d[0], d[1], d[2]);
      expect(terrainHeight(shape, d[0], d[1], d[2])).toBe(h);
      min = Math.min(min, h);
      max = Math.max(max, h);
    }
    expect(max).toBeLessThan(shape.relief * 2.5);
    expect(min).toBeGreaterThan(-shape.relief * 4);
    expect(max).toBeGreaterThan(20); // there is land
    expect(min).toBeLessThan(seaRadius(shape) - shape.radius); // and sea
  });

  it("normals point outward", () => {
    const n = terrainNormal(shape, 0.6, 0.64, 0.48);
    expect(n[0] * 0.6 + n[1] * 0.64 + n[2] * 0.48).toBeGreaterThan(0.5);
  });

  it("craters dig bowls on airless moons", () => {
    const moon: TerrainShape = {
      ...shape,
      seed: 777,
      radius: 600,
      relief: 30,
      waterLevel: -9,
      mountains: 0,
      microRelief: 0,
      craters: [{ frequency: 3, density: 1, radius: [0.4, 0.4], depthRatio: 0.2 }],
    };
    const flat: TerrainShape = { ...moon, craters: [] };
    let deeper = 0;
    const d: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 300; i++) {
      faceToDir(i % 6, ((i * 13) % 100) / 50 - 1, ((i * 71) % 100) / 50 - 1, d);
      if (terrainHeight(moon, d[0], d[1], d[2]) < terrainHeight(flat, d[0], d[1], d[2]) - 5) deeper++;
    }
    expect(deeper).toBeGreaterThan(20);
  });
});

describe("chunk builder", () => {
  const ctx = { shape, palette };

  it("builds a grid + skirts with outward normals and tight bounds", () => {
    const c = buildChunk({ bodyId: "vael", face: 2, level: 3, x: 3, y: 4 }, ctx, "k");
    expect(c.positions.length).toBe(CHUNK_VERTS * 3);
    const idx = chunkIndices();
    expect(Math.max(...idx)).toBeLessThan(CHUNK_VERTS);
    let outward = 0;
    for (let i = 0; i < (GRID + 1) * (GRID + 1); i++) {
      const px = c.positions[i * 3];
      const py = c.positions[i * 3 + 1];
      const pz = c.positions[i * 3 + 2];
      const r = Math.hypot(px, py, pz);
      const dot = (c.normals[i * 3] * px + c.normals[i * 3 + 1] * py + c.normals[i * 3 + 2] * pz) / r;
      if (dot > 0.3) outward++;
      const dist = Math.hypot(px - c.center[0], py - c.center[1], pz - c.center[2]);
      expect(dist).toBeLessThanOrEqual(c.boundRadius + 1e-3);
    }
    expect(outward).toBeGreaterThan((GRID + 1) * (GRID + 1) * 0.98);
  });

  it("front faces wind so cross(p1-p0, p2-p0) points inward (Babylon convention)", () => {
    const c = buildChunk({ bodyId: "vael", face: 4, level: 2, x: 1, y: 2 }, ctx, "k");
    const idx = chunkIndices();
    const p = (i: number) => [c.positions[i * 3], c.positions[i * 3 + 1], c.positions[i * 3 + 2]];
    const [a, b, d] = [p(idx[0]), p(idx[1]), p(idx[2])];
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    expect(n[0] * a[0] + n[1] * a[1] + n[2] * a[2]).toBeLessThan(0);
  });

  it("neighbouring chunks share their edge vertices exactly", () => {
    const left = buildChunk({ bodyId: "vael", face: 0, level: 2, x: 1, y: 1 }, ctx, "a");
    const right = buildChunk({ bodyId: "vael", face: 0, level: 2, x: 2, y: 1 }, ctx, "b");
    const V = GRID + 1;
    for (let j = 0; j < V; j++) {
      const a = (j * V + GRID) * 3;
      const b = (j * V + 0) * 3;
      expect(left.positions[a]).toBe(right.positions[b]);
      expect(left.positions[a + 1]).toBe(right.positions[b + 1]);
      expect(left.normals[a]).toBeCloseTo(right.normals[b], 5);
    }
  });
});

describe("quadtree LOD", () => {
  const params = { radius: 2000, maxHeight: 250, maxLevel: 7, splitFactor: 1.6, occluderRadius: 1992 };

  it("refines to the max level under the camera and stays coarse far away", () => {
    const d: [number, number, number] = [0, 0, 0];
    faceToDir(2, 0.1, 0.2, d);
    const cam: [number, number, number] = [d[0] * 2050, d[1] * 2050, d[2] * 2050];
    const leaves = selectLeaves(cam, params, () => undefined);
    const maxLevel = Math.max(...leaves.map((l) => l.node.level));
    expect(maxLevel).toBe(7);
    // The far side of the planet stays coarse.
    const opposite = leaves.filter((l) => l.node.face === 3);
    expect(Math.max(...opposite.map((l) => l.node.level))).toBeLessThanOrEqual(2);
    expect(leaves.length).toBeLessThan(600);
  });

  it("draw set covers with ready ancestors and never overlaps", () => {
    const d: [number, number, number] = [0, 0, 0];
    faceToDir(0, 0, 0, d);
    const cam: [number, number, number] = [d[0] * 2100, d[1] * 2100, d[2] * 2100];
    const leaves = selectLeaves(cam, params, () => undefined).map((l) => l.node);
    // Only roots + first-level children of face 0 are "built".
    const ready = new Set(roots().map((r) => r.key));
    for (const c of children(roots()[0])) ready.add(c.key);
    const draw = resolveDrawSet(leaves, (k) => ready.has(k));
    for (const k of draw) expect(ready.has(k)).toBe(true);
    // Face 0 is drawn via its 4 children, not the root.
    expect(draw.has(roots()[0].key)).toBe(false);
    expect([...draw].filter((k) => k.startsWith("0/1/")).length).toBe(4);
    // 4 children of face 0 + the side faces; the far face is below the horizon.
    expect(draw.size).toBe(8);
  });
});

describe("vegetation placement", () => {
  const rules = {
    density: 4000,
    line: 0.6,
    shore: 1,
    slope: 0.25,
    polar: 0.8,
    clumpFreq: 1.5,
    clumpLo: 0.3,
    clumpHi: 0.6,
    clumpFloor: 0.2,
    scale: [0.8, 1.2] as [number, number],
    sink: 0.2,
    tint: [1, 1, 1] as [number, number, number],
    coniferAbove: 0.4,
    coniferShare: 0.3,
  };

  it("is deterministic per cell and respects the shore line", () => {
    let found = 0;
    for (let x = 0; x < 40 && found < 3; x++) {
      const req = {
        bodyId: "vael",
        face: 4,
        level: 5,
        x: (x * 7) % 32,
        y: (x * 5) % 32,
        layer: "trees" as const,
        rules,
        seed: 1,
      };
      const a = placeVegetation(req, shape);
      const b = placeVegetation(req, shape);
      expect(Array.from(a.matrices)).toEqual(Array.from(b.matrices));
      const n = a.matrices.length / 16;
      for (let i = 0; i < n; i++) {
        const tx = a.matrices[i * 16 + 12];
        const ty = a.matrices[i * 16 + 13];
        const tz = a.matrices[i * 16 + 14];
        const r = Math.hypot(tx, ty, tz);
        const h = terrainHeight(shape, tx / r, ty / r, tz / r);
        expect(h).toBeGreaterThan(shape.waterLevel * shape.relief);
        expect(Math.abs(r - (shape.radius + h))).toBeLessThan(3);
      }
      if (n > 0) found++;
    }
    expect(found).toBeGreaterThan(0);
  });
});
