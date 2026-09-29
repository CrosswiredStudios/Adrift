/**
 * Quadtree LOD selection for one body's cube-sphere terrain (pure logic).
 *
 * Each update walks the 6 face trees from the camera position (body frame)
 * and picks the set of leaf nodes to show: a node splits while the camera
 * is closer than `splitFactor` x its edge length (down to `maxLevel`).
 * Because meshes are built asynchronously, a desired leaf that isn't ready
 * yet is covered by its nearest ready ancestor, and a ready ancestor hides
 * its whole subtree, so the drawn set never overlaps and never has holes
 * (the 6 face roots are always built first).
 */
import { faceToDir, nodeArcLength, nodeBounds, nodeKey, type NodeAddress } from "./cubeSphere";

export interface LodParams {
  radius: number;
  /** Max terrain height above the mean radius (m), for conservative bounds. */
  maxHeight: number;
  maxLevel: number;
  /** Split while distance < splitFactor * node edge length. */
  splitFactor: number;
  /**
   * Radius of a sphere guaranteed to be hidden behind the surface (sea
   * level on ocean worlds, the lowest terrain otherwise). Nodes completely
   * behind it (below the horizon) are neither refined nor drawn.
   */
  occluderRadius: number;
}

export interface LodNode extends NodeAddress {
  key: string;
}

export interface ChunkBoundsInfo {
  center: [number, number, number];
  boundRadius: number;
  minR: number;
  maxR: number;
}

/** Height range inherited from the nearest built ancestor (for estimates). */
export interface RadiusHint {
  minR: number;
  maxR: number;
}

/**
 * Conservative distance from a body-frame point to a node: to the node's
 * bounding sphere (tight bounds once the chunk is built, estimated before).
 */
export function nodeDistance(
  n: NodeAddress,
  cam: [number, number, number],
  params: LodParams,
  built?: ChunkBoundsInfo,
  hint?: RadiusHint,
): number {
  let cx: number;
  let cy: number;
  let cz: number;
  let br: number;
  if (built) {
    [cx, cy, cz] = built.center;
    br = built.boundRadius;
  } else {
    const { u0, v0, size } = nodeBounds(n);
    const d: [number, number, number] = [0, 0, 0];
    faceToDir(n.face, u0 + size / 2, v0 + size / 2, d);
    // Centre at the ancestor's mid radius; the envelope covers the node's
    // half-diagonal plus a height spread no larger than the ancestor's and
    // no larger than ~the node size (slopes steeper than 1:1 are rare).
    const minR = hint?.minR ?? params.radius - params.maxHeight;
    const maxR = hint?.maxR ?? params.radius + params.maxHeight;
    const r = (minR + maxR) / 2;
    const edge = nodeArcLength(n.level, params.radius);
    cx = d[0] * r;
    cy = d[1] * r;
    cz = d[2] * r;
    br = edge * 0.75 + Math.min((maxR - minR) / 2, edge * 0.6);
  }
  const dx = cam[0] - cx;
  const dy = cam[1] - cy;
  const dz = cam[2] - cz;
  return Math.max(0, Math.hypot(dx, dy, dz) - br);
}

export function children(n: NodeAddress): LodNode[] {
  const out: LodNode[] = [];
  for (let j = 0; j < 2; j++)
    for (let i = 0; i < 2; i++) {
      const c = { face: n.face, level: n.level + 1, x: n.x * 2 + i, y: n.y * 2 + j };
      out.push({ ...c, key: nodeKey(c) });
    }
  return out;
}

export function parentOf(n: NodeAddress): LodNode | null {
  if (n.level === 0) return null;
  const p = { face: n.face, level: n.level - 1, x: n.x >> 1, y: n.y >> 1 };
  return { ...p, key: nodeKey(p) };
}

export function roots(): LodNode[] {
  return [0, 1, 2, 3, 4, 5].map((face) => {
    const n = { face, level: 0, x: 0, y: 0 };
    return { ...n, key: nodeKey(n) };
  });
}

/**
 * True when a node lies entirely beyond the horizon of the occluder sphere.
 * A point at radius rp is visible from a camera at distance D iff the angle
 * between them (seen from the centre) is <= acos(ro/D) + acos(ro/rp); the
 * node's angular half-size makes the test conservative.
 */
export function belowHorizon(
  n: NodeAddress,
  cam: [number, number, number],
  params: LodParams,
  built?: ChunkBoundsInfo,
  hint?: RadiusHint,
): boolean {
  const ro = params.occluderRadius;
  const D = Math.hypot(cam[0], cam[1], cam[2]);
  if (D <= ro) return false;
  const { u0, v0, size } = nodeBounds(n);
  const d: [number, number, number] = [0, 0, 0];
  faceToDir(n.face, u0 + size / 2, v0 + size / 2, d);
  const edge = nodeArcLength(n.level, params.radius);
  const maxR = built?.maxR ?? hint?.maxR ?? params.radius + params.maxHeight;
  const rTop = Math.max(maxR, ro);
  const cosTheta = (d[0] * cam[0] + d[1] * cam[1] + d[2] * cam[2]) / D;
  const theta = Math.acos(Math.max(-1, Math.min(1, cosTheta)));
  const halfSize = (edge * 0.75) / params.radius; // angular half-diagonal
  return theta - halfSize > Math.acos(ro / D) + Math.acos(ro / rTop);
}

/**
 * Desired leaves for a camera position (body frame).
 *
 * Refinement is progressive: a node only splits once it has been built
 * itself (`bounds` known), so the tree deepens one level at a time around
 * the camera and there is always a close ancestor to draw while the finer
 * chunks stream in (instead of falling back to the face roots). Pass
 * `progressive = false` to get the full target set regardless of what is
 * built (tests, planning).
 */
export function selectLeaves(
  cam: [number, number, number],
  params: LodParams,
  bounds: (key: string) => ChunkBoundsInfo | undefined,
  progressive = false,
): { node: LodNode; distance: number }[] {
  const out: { node: LodNode; distance: number }[] = [];
  const visit = (n: LodNode, hint: RadiusHint | undefined): void => {
    const built = bounds(n.key);
    if (n.level > 0 && belowHorizon(n, cam, params, built, hint)) return;
    const dist = nodeDistance(n, cam, params, built, hint);
    const edge = nodeArcLength(n.level, params.radius);
    const canSplit = !progressive || n.level === 0 || built !== undefined;
    if (n.level < params.maxLevel && dist < params.splitFactor * edge && canSplit) {
      const next = built ? { minR: built.minR, maxR: built.maxR } : hint;
      for (const c of children(n)) visit(c, next);
    } else {
      out.push({ node: n, distance: dist });
    }
  };
  for (const r of roots()) visit(r, undefined);
  return out;
}

/**
 * Resolve what to draw: each desired leaf, or its nearest ready ancestor,
 * with nodes whose ancestor is drawn removed (no overlaps).
 */
export function resolveDrawSet(leaves: LodNode[], isReady: (key: string) => boolean): Set<string> {
  const draw = new Set<string>();
  for (const leaf of leaves) {
    let n: LodNode | null = leaf;
    while (n && !isReady(n.key)) n = parentOf(n);
    if (n) draw.add(n.key);
  }
  // Drop any node that has a drawn ancestor.
  const result = new Set<string>();
  for (const key of draw) {
    const [face, level, x, y] = key.split("/").map(Number);
    let p = parentOf({ face, level, x, y });
    let covered = false;
    while (p) {
      if (draw.has(p.key)) {
        covered = true;
        break;
      }
      p = parentOf(p);
    }
    if (!covered) result.add(key);
  }
  return result;
}
