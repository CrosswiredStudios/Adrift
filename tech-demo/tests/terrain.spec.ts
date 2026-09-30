import { test, expect } from "@playwright/test";
import { expectNoErrors, sharedGame } from "./helpers";

const shared = sharedGame();

test("quadtree refines around the player and textures load", async () => {
  test.setTimeout(420000);
  const page = shared.page();
  await page.evaluate(() => (window as any).__game.freeze());
  // Streaming runs in the workers in real time; wait for sub-meter chunks.
  await page.waitForFunction(() => (window as any).__game.terrain("vael").maxDrawnLevel >= 7, null, {
    timeout: 400000,
    polling: 1000,
  });
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    return { terrain: g.terrain("vael"), textures: g.textures("vael"), moon: g.terrain("tethys") };
  });
  expect(res.terrain.maxDrawnLevel).toBe(7); // ~0.77 m vertex spacing under the player
  expect(res.terrain.drawn).toBeLessThan(600);
  expect(res.textures.ready).toBe(true);
  expect(res.textures.fallbacks).toEqual([]);
  // The moon stays at coarse levels while we're on Vael, 12 km away.
  expect(res.moon.maxDrawnLevel).toBeLessThanOrEqual(2);
  expectNoErrors(shared.errors());
});

test("the depth pass draws terrain with the geomorph material", async () => {
  const page = shared.page();
  // Babylon compiles the per-pass effect on first use: render until ready.
  await page.waitForFunction(
    () => {
      const g = (window as any).__game;
      g.render();
      const dr = g.scene.enableDepthRenderer(g.camera, false, true);
      const passId = dr.getDepthMap().renderPassId;
      const chunks = g.scene.meshes.filter((m: any) => m.metadata?.terrainBody === "vael" && m.isEnabled());
      return (
        chunks.length > 0 &&
        chunks.every((m: any) => {
          const mat = m._internalAbstractMeshDataInfo._materialForRenderPass?.[passId];
          return mat?.getClassName() === "ShaderMaterial" && dr.isReady(m.subMeshes[0], false);
        })
      );
    },
    null,
    { timeout: 60000, polling: 500 },
  );
  expectNoErrors(shared.errors());
});

test("collision uses the exact height field the chunks are built from", async () => {
  const page = shared.page();
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    const errs: number[] = [];
    // Sample a few lat/lon points: the player stands exactly on the surface there.
    for (const [lat, lon] of [
      [26.5, 96],
      [26.52, 96.03],
      [26.47, 95.98],
    ]) {
      g.placePlayer("vael", lat, lon, 0);
      g.step(0.5);
      const h = g.terrainHeightAt("vael", lat, lon);
      const r = g.sim.player.pos.length() - 2000;
      errs.push(Math.abs(r - h));
    }
    return errs;
  });
  for (const e of res) expect(e).toBeLessThan(0.35); // settled within a step of where it was placed
  expectNoErrors(shared.errors());
});

test("terrain debug views compile", async () => {
  const page = shared.page();
  for (const mode of [1, 2, 3, 0]) {
    await page.evaluate((m) => {
      const g = (window as any).__game;
      g.terrainDebug(m);
      g.render();
    }, mode);
  }
  expectNoErrors(shared.errors());
});
