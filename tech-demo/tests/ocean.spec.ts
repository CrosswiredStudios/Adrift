import { test, expect } from "@playwright/test";
import { expectNoErrors, sharedGame } from "./helpers";

const shared = sharedGame();

/** Find an open-water point near the crash site (CPU height field). */
async function findWater(page: any): Promise<[number, number]> {
  return page.evaluate(() => {
    const g = (window as any).__game;
    const sea = g.sim.defs.get("vael").terrain.waterLevel * g.sim.defs.get("vael").terrain.relief;
    for (let r = 0.2; r < 20; r += 0.2) {
      for (let a = 0; a < 360; a += 15) {
        const lat = 26.5 + r * Math.cos((a * Math.PI) / 180);
        const lon = 96 + r * Math.sin((a * Math.PI) / 180);
        if (g.terrainHeightAt("vael", lat, lon) < sea - 15) return [lat, lon];
      }
    }
    throw new Error("no water found");
  });
}

test("the skiff floats and rides the waves", async () => {
  const page = shared.page();
  const [lat, lon] = await findWater(page);
  const res = await page.evaluate(
    ([la, lo]: number[]) => {
      const g = (window as any).__game;
      g.freeze();
      g.setMode("ship");
      g.placeShip("vael", la, lo, 6, 0);
      g.sim.ship.assist = false;
      let splashes = 0;
      const off = g.events.on("splash", () => splashes++);
      g.step(12);
      off();
      const dir = g.sim.ship.pos.clone().normalize();
      const water = g.waterRadius("vael", dir.asArray());
      const heights: number[] = [];
      for (let i = 0; i < 20; i++) {
        g.step(0.25);
        heights.push(g.sim.ship.pos.length());
      }
      return {
        floating: g.sim.ship.floating,
        aboveWater: g.sim.ship.pos.length() - water,
        bob: Math.max(...heights) - Math.min(...heights),
        splashes,
      };
    },
    [lat, lon],
  );
  expect(res.floating).toBe(true);
  expect(res.aboveWater).toBeGreaterThan(-1.5);
  expect(res.aboveWater).toBeLessThan(1.5);
  expect(res.bob).toBeGreaterThan(0.01); // waves move it
  expect(res.bob).toBeLessThan(2);
  expect(res.splashes).toBeGreaterThan(0);
  expectNoErrors(shared.errors());
});

test("ocean builds its depth map in the workers and the patch follows the camera", async () => {
  test.setTimeout(420000);
  const page = shared.page();
  await page.waitForFunction(() => (window as any).__game.ocean("vael").heightMap === true, null, {
    timeout: 400000,
    polling: 1000,
  });
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    g.render();
    const near = g.ocean("vael");
    g.placeShip("vael", 0, 0, 3000, 0);
    g.step(1 / 60);
    g.render();
    const far = g.ocean("vael");
    return { near: near.patchOn, far: far.patchOn, waves: near.waveCount };
  });
  expect(res.near).toBe(true);
  expect(res.far).toBe(false);
  expect(res.waves).toBeGreaterThan(6);
  for (const mode of [1, 2, 3, 0]) await page.evaluate((m) => (window as any).__game.oceanDebug(m), mode);
  expectNoErrors(shared.errors());
});
