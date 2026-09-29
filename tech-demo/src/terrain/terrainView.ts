/**
 * Babylon side of the quadtree terrain for one body.
 *
 * Each frame: pick the desired leaves for the camera (body frame), queue
 * missing chunks on the worker pool (nearest first), resolve what can be
 * drawn now (ready leaves or their nearest ready ancestors), toggle meshes,
 * and evict chunks that haven't been needed for a while. Mesh creation is
 * budgeted per frame so a burst of finished chunks can't cause a hitch.
 */
import { Material, Mesh, Scene, TransformNode, VertexBuffer } from "@babylonjs/core";
import { selectLeaves, resolveDrawSet, roots, type ChunkBoundsInfo, type LodParams } from "./quadtree";
import { chunkIndices, type ChunkData } from "./chunkBuilder";
import { nodeKey, levelForSpacing } from "./cubeSphere";
import { GRID } from "./chunkBuilder";
import { CancelledError, type TerrainWorkerPool } from "./workerPool";
import { runJob } from "./terrainJobs";
import type { TerrainShape } from "./heightField";

interface ChunkEntry {
  key: string;
  bounds: ChunkBoundsInfo;
  mesh: Mesh;
  lastUsed: number;
}

export interface TerrainViewOptions {
  scene: Scene;
  bodyId: string;
  shape: TerrainShape;
  root: TransformNode;
  material: Material;
  pool: TerrainWorkerPool;
  /** Target vertex spacing at the finest level (m). */
  leafSpacing?: number;
  splitFactor?: number;
}

export interface TerrainStats {
  chunks: number;
  drawn: number;
  pending: number;
  maxDrawnLevel: number;
  built: number;
}

const MAX_MESHES_PER_FRAME = 12;
const EVICT_AFTER_MS = 15000;
const MAX_CACHED = 900;

export class TerrainView {
  readonly params: LodParams;
  readonly meshes = new Set<Mesh>();
  private readonly chunks = new Map<string, ChunkEntry>();
  private readonly pending = new Set<string>();
  private readonly arrived: ChunkData[] = [];
  private drawn = new Set<string>();
  private built = 0;
  private visible = true;

  constructor(private readonly o: TerrainViewOptions) {
    const maxLevel = levelForSpacing(o.shape.radius, GRID, o.leafSpacing ?? 0.8);
    const lowest = o.shape.waterLevel > -8 ? o.shape.waterLevel * o.shape.relief : -o.shape.relief * 1.5;
    this.params = {
      radius: o.shape.radius,
      maxHeight: o.shape.relief * 2.2 + o.shape.microRelief * 2,
      maxLevel,
      splitFactor: o.splitFactor ?? 1.6,
      occluderRadius: o.shape.radius + Math.min(lowest, -o.shape.relief * 0.2),
    };
    // The six face roots are built synchronously so there is always
    // something to draw (and to fall back to) from the first frame.
    for (const r of roots()) {
      const { result } = runJob({
        kind: "chunk",
        req: { bodyId: o.bodyId, face: r.face, level: 0, x: 0, y: 0 },
      });
      if (result.kind === "chunk") this.createMesh(result.data, performance.now());
    }
  }

  get bodyId(): string {
    return this.o.bodyId;
  }

  /** Per-frame LOD update. `cam` is the camera position in the body frame. */
  update(cam: [number, number, number]): void {
    const now = performance.now();
    // Turn finished jobs into meshes (budgeted).
    let made = 0;
    while (this.arrived.length && made < MAX_MESHES_PER_FRAME) {
      const data = this.arrived.shift()!;
      this.pending.delete(data.key);
      if (!this.chunks.has(data.key)) {
        this.createMesh(data, now);
        made++;
      }
    }

    const leaves = selectLeaves(cam, this.params, (k) => this.chunks.get(this.fullKey(k))?.bounds, true);
    const wanted = new Set<string>();
    for (const { node, distance } of leaves) {
      const key = this.fullKey(node.key);
      wanted.add(key);
      if (!this.chunks.has(key) && !this.pending.has(key)) this.request(node, distance);
      else if (this.pending.has(key)) this.o.pool.reprioritize(key, distance);
    }
    // Stop building chunks the camera no longer needs.
    const prefix = this.o.bodyId + ":";
    this.o.pool.prune(
      (key) =>
        !key.startsWith(prefix) ||
        key.startsWith(prefix + "v:") ||
        key.startsWith(prefix + "bake") ||
        wanted.has(key),
    );
    for (const key of [...this.pending])
      if (!wanted.has(key) && !this.o.pool.isQueued(key)) this.pending.delete(key);

    const drawSet = resolveDrawSet(
      leaves.map((l) => l.node),
      (k) => this.chunks.has(this.fullKey(k)),
    );
    const drawKeys = new Set([...drawSet].map((k) => this.fullKey(k)));
    for (const key of this.drawn) {
      if (!drawKeys.has(key)) this.chunks.get(key)?.mesh.setEnabled(false);
    }
    for (const key of drawKeys) {
      const c = this.chunks.get(key);
      if (!c) continue;
      c.mesh.setEnabled(this.visible);
      c.lastUsed = now;
    }
    // Ancestors of drawn/wanted nodes stay warm (they are the fallbacks).
    for (const key of wanted) {
      const c = this.chunks.get(key);
      if (c) c.lastUsed = now;
    }
    this.drawn = drawKeys;
    this.evict(now);
  }

  private fullKey(nodeKeyStr: string): string {
    return `${this.o.bodyId}:${nodeKeyStr}`;
  }

  private job(node: { face: number; level: number; x: number; y: number }) {
    return {
      kind: "chunk" as const,
      req: { bodyId: this.o.bodyId, face: node.face, level: node.level, x: node.x, y: node.y },
    };
  }

  private request(node: { face: number; level: number; x: number; y: number }, distance: number): void {
    const key = this.fullKey(nodeKey(node));
    this.pending.add(key);
    this.o.pool
      .request(key, this.job(node), distance)
      .then((r) => {
        if (r.kind === "chunk") this.arrived.push(r.data);
      })
      .catch((e) => {
        this.pending.delete(key);
        if (!(e instanceof CancelledError)) console.error(e);
      });
  }

  private createMesh(data: ChunkData, now: number): void {
    const mesh = new Mesh(data.key, this.o.scene);
    mesh.setVerticesData(VertexBuffer.PositionKind, data.positions, false, 3);
    mesh.setVerticesData(VertexBuffer.NormalKind, data.normals, false, 3);
    mesh.setVerticesData(VertexBuffer.ColorKind, data.colors, false, 4);
    mesh.setIndices(chunkIndices());
    mesh.material = this.o.material;
    mesh.parent = this.o.root;
    mesh.isPickable = false;
    mesh.hasVertexAlpha = false;
    mesh.useVertexColors = true;
    mesh.metadata = { terrainBody: this.o.bodyId };
    mesh.setEnabled(false);
    mesh.refreshBoundingInfo();
    this.chunks.set(data.key, {
      key: data.key,
      mesh,
      lastUsed: now,
      bounds: { center: data.center, boundRadius: data.boundRadius, minR: data.minR, maxR: data.maxR },
    });
    this.meshes.add(mesh);
    this.built++;
  }

  private evict(now: number): void {
    if (this.chunks.size <= MAX_CACHED * 0.5) return;
    // Never evict the face roots: they are the fallback of last resort.
    const old = [...this.chunks.values()]
      .filter(
        (c) => !this.drawn.has(c.key) && now - c.lastUsed > EVICT_AFTER_MS && !/:\d\/0\/0\/0$/.test(c.key),
      )
      .sort((a, b) => a.lastUsed - b.lastUsed);
    const excess = Math.max(0, this.chunks.size - MAX_CACHED * 0.5);
    for (const c of old.slice(0, Math.max(excess, old.length > 200 ? 50 : 0))) {
      c.mesh.dispose();
      this.meshes.delete(c.mesh);
      this.chunks.delete(c.key);
    }
  }

  setVisible(on: boolean): void {
    this.visible = on;
    for (const key of this.drawn) this.chunks.get(key)?.mesh.setEnabled(on);
  }

  /** True when every desired leaf is drawn at its own level (nothing pending). */
  settled(): boolean {
    return this.pending.size === 0 && this.arrived.length === 0;
  }

  stats(): TerrainStats {
    let maxLevel = 0;
    for (const key of this.drawn) {
      const level = Number(key.split(":")[1].split("/")[1]);
      maxLevel = Math.max(maxLevel, level);
    }
    return {
      chunks: this.chunks.size,
      drawn: this.drawn.size,
      pending: this.pending.size,
      maxDrawnLevel: maxLevel,
      built: this.built,
    };
  }

  dispose(): void {
    for (const c of this.chunks.values()) c.mesh.dispose();
    this.chunks.clear();
    this.meshes.clear();
  }
}
