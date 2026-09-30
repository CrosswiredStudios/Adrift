import { test, expect } from "@playwright/test";
import { expectNoErrors, sharedGame, waitSettled } from "./helpers";

const shared = sharedGame();

test("vegetation streams in around the player, on land only", async () => {
  test.setTimeout(420000);
  const page = shared.page();
  await page.evaluate(() => (window as any).__game.freeze());
  await waitSettled(page, 400000);
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    const status = g.vegetation("vael");
    const shape = g.sim.defs.get("vael").terrain;
    const sea = shape.waterLevel * shape.relief;
    const bad: number[] = [];
    for (const sp of ["broadleaf", "conifer", "shrub", "grass"]) {
      for (const p of g.vegetationSample("vael", sp, 200)) {
        const r = Math.hypot(p[0], p[1], p[2]);
        if (r - 2000 < sea + 0.5) bad.push(r - 2000);
      }
    }
    return { status, bad, moon: g.vegetation("tethys") };
  });
  expect(res.status.cells).toBeGreaterThan(20);
  expect(res.status.instances.broadleaf + res.status.instances.conifer).toBeGreaterThan(50);
  expect(res.status.instances.grass).toBeGreaterThan(100);
  expect(res.status.ready).toBe(true);
  expect(res.bad).toEqual([]);
  expect(res.moon).toBeNull(); // airless moon: no flora
  expectNoErrors(shared.errors());
});
