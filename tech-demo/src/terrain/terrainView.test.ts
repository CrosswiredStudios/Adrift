import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine, Scene, StandardMaterial, TransformNode } from "@babylonjs/core";
import { TerrainView } from "./terrainView";
import { TerrainWorkerPool } from "./workerPool";
import { faceToDir } from "./cubeSphere";
import { defaultShores, type TerrainShape } from "./heightField";
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

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

describe("terrain view", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the ancestors of what it draws cached (no periodic collapse)", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const pool = new TerrainWorkerPool(null, 1);
    pool.init({ kind: "init", bodies: { vael: { shape, palette } } });
    const view = new TerrainView({
      scene,
      bodyId: "vael",
      shape,
      root: new TransformNode("root", scene),
      material: new StandardMaterial("m", scene),
      pool,
      leafSpacing: 3,
    });
    const at = (u: number, v: number, alt: number): [number, number, number] => {
      const d: [number, number, number] = [0, 0, 0];
      faceToDir(2, u, v, d);
      const r = shape.radius + shape.relief * 2 + alt;
      return [d[0] * r, d[1] * r, d[2] * r];
    };
    const settle = async (cam: [number, number, number]): Promise<void> => {
      for (let i = 0; i < 400 && !(i > 2 && view.settled()); i++) {
        view.update(cam);
        await flush();
        now += 50;
      }
    };
    // Fly a low pass over the surface so the cache fills past the eviction
    // threshold, then hover.
    for (let k = 0; k <= 12; k++) await settle(at(-0.6 + k * 0.1, 0.1, 20));
    const hover = at(0.6, 0.1, 20);
    await settle(hover);
    expect(view.stats().chunks).toBeGreaterThan(450);
    const level = view.stats().maxDrawnLevel;
    const drawn = view.stats().drawn;
    const built = view.stats().built;
    // Hover well past the eviction age: nothing we draw collapses or rebuilds.
    for (let i = 0; i < 400; i++) {
      view.update(hover);
      await flush();
      now += 100;
      expect(view.stats().maxDrawnLevel).toBe(level);
      expect(view.stats().drawn).toBe(drawn);
    }
    expect(view.stats().built).toBe(built);
    view.dispose();
    engine.dispose();
  }, 60000);
});
