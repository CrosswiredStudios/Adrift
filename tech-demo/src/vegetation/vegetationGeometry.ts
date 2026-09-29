import { Vector3 } from "@babylonjs/core";
import type { VegetationLook } from "./vegetationLook";

/**
 * Species geometry for the instanced flora (SRP: card/trunk builders +
 * per-species assemblies live here; placement + instancing live in
 * vegetation.ts). Extracted verbatim from vegetation.ts so the meshes are
 * byte-identical.
 */

export interface GeoAccum {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

export function newGeo(): GeoAccum {
  return { positions: [], normals: [], uvs: [], indices: [] };
}

/**
 * Adds a double-sided card (quad) centred at c with local right/up axes.
 * Winding/normal follow the ground-mesh convention (indices a,c,b / b,c,d
 * with normal = cross(tx, ty)) so the base normals face outward of the card.
 */
export function addCard(
  g: GeoAccum,
  cx: number,
  cy: number,
  cz: number,
  right: Vector3,
  up: Vector3,
  w: number,
  h: number,
): void {
  const base = g.positions.length / 3;
  const hw = w / 2,
    hh = h / 2;
  const n = Vector3.Cross(right, up).normalize();
  const corners: Array<[number, number, number, number]> = [
    // [right, up, u, v]
    [-hw, -hh, 0, 0],
    [hw, -hh, 1, 0],
    [-hw, hh, 0, 1],
    [hw, hh, 1, 1],
  ];
  for (const [r, u, tu, tv] of corners) {
    g.positions.push(cx + right.x * r + up.x * u, cy + right.y * r + up.y * u, cz + right.z * r + up.z * u);
    g.normals.push(n.x, n.y, n.z);
    g.uvs.push(tu, tv);
  }
  g.indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
}

/**
 * Tapered trunk with a slight lean. Rings run top→bottom so the (a,c,b)
 * winding yields outward-facing sides (matching the ground-mesh rule with
 * tx = +angle, ty = −up). Base sits at y=0; UVs give ~2 bark wraps.
 */
export function addTrunk(
  g: GeoAccum,
  height: number,
  rBottom: number,
  rMid: number,
  rTop: number,
  leanX: number,
  leanZ: number,
  sides = 7,
): void {
  const rings: Array<[number, number]> = [
    [height, rTop],
    [height * 0.55, rMid],
    [0, rBottom],
  ];
  for (let iy = 0; iy < rings.length; iy++) {
    const [y, r] = rings[iy];
    const t = y / height; // 0 at base, 1 at top
    const lean = t * t;
    for (let ix = 0; ix <= sides; ix++) {
      const a = (ix / sides) * Math.PI * 2;
      const cos = Math.cos(a),
        sin = Math.sin(a);
      g.positions.push(cos * r + leanX * lean, y, sin * r + leanZ * lean);
      const nx = cos,
        nz = sin;
      const nl = Math.hypot(nx, 0.35, nz);
      g.normals.push(nx / nl, 0.35 / nl, nz / nl);
      g.uvs.push((ix / sides) * 2.0, (1 - y / height) * 1.4);
    }
  }
  for (let iy = 0; iy < rings.length - 1; iy++) {
    for (let ix = 0; ix < sides; ix++) {
      const a = iy * (sides + 1) + ix;
      const b = a + 1;
      const c = a + (sides + 1);
      const d = c + 1;
      g.indices.push(a, c, b, b, c, d);
    }
  }
}

export interface SpeciesGeometry {
  meshName: string;
  geo: GeoAccum;
  material: "bark" | "plants" | "grass" | "canopy" | "needles";
}

export function buildBroadleafGeometry(look: VegetationLook): SpeciesGeometry[] {
  const H = look.treeHeight;
  const trunk = newGeo();
  addTrunk(trunk, H * 0.5, H * 0.085, H * 0.055, H * 0.03, H * 0.02, H * 0.01);

  const canopy = newGeo();
  const cw = H * 0.9,
    ch = H * 0.72,
    cy = H * 0.64;
  const offsets: Array<[number, number, number]> = [
    [0.02, 0, 0],
    [-0.03, 0.012, 0.02],
    [0.04, -0.01, -0.02],
  ];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI;
    const [ox, oy, oz] = offsets[i];
    addCard(
      canopy,
      H * ox,
      cy + H * oy,
      H * oz,
      new Vector3(Math.cos(a), 0, Math.sin(a)),
      new Vector3(0, 1, 0),
      cw,
      ch,
    );
  }
  // Horizontal crown card closes the silhouette seen from above.
  addCard(canopy, 0, cy + ch * 0.42, 0, new Vector3(1, 0, 0), new Vector3(0, 0, -1), cw * 0.8, cw * 0.8);

  return [
    { meshName: "trunk-a", geo: trunk, material: "bark" },
    { meshName: "canopy-a", geo: canopy, material: "canopy" },
  ];
}

export function buildConiferGeometry(look: VegetationLook): SpeciesGeometry[] {
  const H = look.coniferHeight;
  const trunk = newGeo();
  addTrunk(trunk, H * 0.42, H * 0.07, H * 0.046, H * 0.026, H * 0.015, H * 0.008);

  const canopy = newGeo();
  const lower = [0, Math.PI / 3, (Math.PI * 2) / 3];
  for (const a of lower) {
    addCard(
      canopy,
      0,
      H * 0.5,
      0,
      new Vector3(Math.cos(a), 0, Math.sin(a)),
      new Vector3(0, 1, 0),
      H * 0.7,
      H * 0.62,
    );
  }
  const upper = [Math.PI / 4, (Math.PI * 3) / 4];
  for (const a of upper) {
    addCard(
      canopy,
      0,
      H * 0.78,
      0,
      new Vector3(Math.cos(a), 0, Math.sin(a)),
      new Vector3(0, 1, 0),
      H * 0.46,
      H * 0.5,
    );
  }
  return [
    { meshName: "trunk-b", geo: trunk, material: "bark" },
    { meshName: "canopy-b", geo: canopy, material: "needles" },
  ];
}

/**
 * Tilt card normals toward +Y (`k` = 1: straight up). Low plants then shade
 * like the ground they grow from instead of going dark whenever the sun is
 * behind a vertical card.
 */
function bendNormalsUp(g: GeoAccum, k: number): void {
  for (let i = 0; i < g.normals.length; i += 3) {
    const x = g.normals[i] * (1 - k);
    const y = g.normals[i + 1] * (1 - k) + k;
    const z = g.normals[i + 2] * (1 - k);
    const l = Math.hypot(x, y, z) || 1;
    g.normals[i] = x / l;
    g.normals[i + 1] = y / l;
    g.normals[i + 2] = z / l;
  }
}

export function buildShrubGeometry(look: VegetationLook): SpeciesGeometry[] {
  const H = look.shrubHeight;
  const geo = newGeo();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI;
    addCard(
      geo,
      0,
      H * 0.45,
      0,
      new Vector3(Math.cos(a), 0, Math.sin(a)),
      new Vector3(0, 1, 0),
      H * 1.25,
      H * 0.95,
    );
  }
  bendNormalsUp(geo, 0.75);
  return [{ meshName: "shrub", geo, material: "plants" }];
}

export function buildGrassGeometry(look: VegetationLook): SpeciesGeometry[] {
  const H = look.grassHeight;
  const geo = newGeo();
  for (let i = 0; i < 2; i++) {
    const a = (i / 2) * Math.PI;
    addCard(
      geo,
      0,
      H * 0.42,
      0,
      new Vector3(Math.cos(a), 0, Math.sin(a)),
      new Vector3(0, 1, 0),
      H * 1.3,
      H * 0.9,
    );
  }
  bendNormalsUp(geo, 1);
  return [{ meshName: "grass", geo, material: "grass" }];
}
