/**
 * Cube-sphere addressing for planet terrain.
 *
 * The sphere is split into 6 cube faces, each a quadtree. A node covers
 * the face square [u0, u1] x [v0, v1] in [-1, 1]^2; a face point maps to a
 * unit direction through the "spherified cube" mapping, which spreads area
 * much more evenly than plain normalization (no pole pinching, cells stay
 * within ~1.4x of each other in size).
 *
 * No Babylon imports (runs in workers).
 */

export interface FaceAxes {
  /** Face normal (cube face centre). */
  n: [number, number, number];
  /** Tangent for +u. */
  a: [number, number, number];
  /** Tangent for +v. */
  b: [number, number, number];
}

/** +X, -X, +Y, -Y, +Z, -Z. For every face, a x b points along n. */
export const FACES: FaceAxes[] = [
  { n: [1, 0, 0], a: [0, 0, -1], b: [0, 1, 0] },
  { n: [-1, 0, 0], a: [0, 0, 1], b: [0, 1, 0] },
  { n: [0, 1, 0], a: [1, 0, 0], b: [0, 0, -1] },
  { n: [0, -1, 0], a: [1, 0, 0], b: [0, 0, 1] },
  { n: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0] },
  { n: [0, 0, -1], a: [-1, 0, 0], b: [0, 1, 0] },
];

/**
 * Face coordinates -> unit direction (spherified cube), written into `out`.
 */
export function faceToDir(
  face: number,
  u: number,
  v: number,
  out: [number, number, number],
): [number, number, number] {
  const F = FACES[face];
  const cx = F.n[0] + u * F.a[0] + v * F.b[0];
  const cy = F.n[1] + u * F.a[1] + v * F.b[1];
  const cz = F.n[2] + u * F.a[2] + v * F.b[2];
  const x2 = cx * cx;
  const y2 = cy * cy;
  const z2 = cz * cz;
  const sx = cx * Math.sqrt(Math.max(0, 1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3));
  const sy = cy * Math.sqrt(Math.max(0, 1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3));
  const sz = cz * Math.sqrt(Math.max(0, 1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3));
  // The mapping is already unit length; renormalize to kill rounding error.
  const l = Math.hypot(sx, sy, sz);
  out[0] = sx / l;
  out[1] = sy / l;
  out[2] = sz / l;
  return out;
}

/** Which face a direction falls on (largest axis). */
export function dirToFace(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  if (ax >= ay && ax >= az) return x >= 0 ? 0 : 1;
  if (ay >= az) return y >= 0 ? 2 : 3;
  return z >= 0 ? 4 : 5;
}

/**
 * Inverse of faceToDir (direction -> face u, v). Uses Newton iterations on
 * the spherified mapping, starting from the gnomonic projection.
 */
export function dirToFaceUv(
  x: number,
  y: number,
  z: number,
  face = dirToFace(x, y, z),
): { face: number; u: number; v: number } {
  const F = FACES[face];
  const dn = x * F.n[0] + y * F.n[1] + z * F.n[2];
  let u = (x * F.a[0] + y * F.a[1] + z * F.a[2]) / dn;
  let v = (x * F.b[0] + y * F.b[1] + z * F.b[2]) / dn;
  const p: [number, number, number] = [0, 0, 0];
  const pu: [number, number, number] = [0, 0, 0];
  const pv: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 6; i++) {
    faceToDir(face, u, v, p);
    const h = 1e-5;
    faceToDir(face, u + h, v, pu);
    faceToDir(face, u, v + h, pv);
    // Project the error onto the local tangents (2x2 Gauss-Newton).
    const ex = x - p[0];
    const ey = y - p[1];
    const ez = z - p[2];
    const jux = (pu[0] - p[0]) / h;
    const juy = (pu[1] - p[1]) / h;
    const juz = (pu[2] - p[2]) / h;
    const jvx = (pv[0] - p[0]) / h;
    const jvy = (pv[1] - p[1]) / h;
    const jvz = (pv[2] - p[2]) / h;
    const a11 = jux * jux + juy * juy + juz * juz;
    const a12 = jux * jvx + juy * jvy + juz * jvz;
    const a22 = jvx * jvx + jvy * jvy + jvz * jvz;
    const b1 = jux * ex + juy * ey + juz * ez;
    const b2 = jvx * ex + jvy * ey + jvz * ez;
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-20) break;
    const du = (a22 * b1 - a12 * b2) / det;
    const dv = (a11 * b2 - a12 * b1) / det;
    u += du;
    v += dv;
    if (Math.abs(du) + Math.abs(dv) < 1e-12) break;
  }
  return { face, u: Math.max(-1, Math.min(1, u)), v: Math.max(-1, Math.min(1, v)) };
}

export interface NodeAddress {
  face: number;
  level: number;
  x: number;
  y: number;
}

export function nodeKey(n: NodeAddress): string {
  return `${n.face}/${n.level}/${n.x}/${n.y}`;
}

/** Face-space bounds of a node. */
export function nodeBounds(n: NodeAddress): { u0: number; v0: number; size: number } {
  const size = 2 / (1 << n.level);
  return { u0: -1 + n.x * size, v0: -1 + n.y * size, size };
}

/** Approximate edge length of a node on the sphere (m). */
export function nodeArcLength(level: number, radius: number): number {
  // A face spans ~90 degrees of arc.
  return ((Math.PI / 2) * radius) / (1 << level);
}

/** Deepest quadtree level whose vertex spacing is at most `spacing` meters. */
export function levelForSpacing(radius: number, gridSize: number, spacing: number): number {
  let level = 0;
  while (nodeArcLength(level, radius) / gridSize > spacing && level < 20) level++;
  return level;
}
