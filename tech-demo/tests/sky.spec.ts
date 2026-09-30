import { test, expect } from "@playwright/test";
import { expectNoErrors, sharedGame } from "./helpers";

const shared = sharedGame();

test("flying into a cloud raises the whiteout veil from the same density field", async () => {
  const page = shared.page();
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    g.freeze();
    const cp = g.views.get("vael").clouds;
    // Scan the deck (body frame) for a dense spot.
    const mid = cp.radius + cp.base + cp.thickness * 0.5;
    let best: number[] | null = null;
    let bestD = 0;
    for (let i = 0; i < 2000 && bestD < 0.6; i++) {
      const z = 1 - (2 * (i + 0.5)) / 2000;
      const r = Math.sqrt(1 - z * z);
      const phi = i * 2.39996;
      const p = [r * Math.cos(phi) * mid, z * mid, r * Math.sin(phi) * mid];
      const d = g.cloudDensity("vael", p);
      if (d > bestD) {
        bestD = d;
        best = p;
      }
    }
    // Put the chase camera inside it: park the ship there in cockpit view.
    const V = g.sim.ship.pos.constructor;
    const dir = new V(best![0], best![1], best![2]).normalize();
    const lat = (Math.asin(dir.y) * 180) / Math.PI;
    const lon = (-Math.atan2(dir.z, dir.x) * 180) / Math.PI;
    const ground = g.terrainHeightAt("vael", lat, lon);
    g.placeShip("vael", lat, lon, mid - 2000 - ground - 0.62, 0);
    g.setMode("ship");
    g.game.cameraMode = "cockpit";
    g.sim.ship.assist = true;
    // Large frame steps: the veil eases with min(1, rate * dt), so a few frames settle it.
    for (let i = 0; i < 4; i++) g.game.renderFrame(1, 1);
    const inside = g.clouds();
    g.placeShip("vael", lat, lon, 50, 0);
    g.step(1 / 60);
    for (let i = 0; i < 4; i++) g.game.renderFrame(1, 1);
    const below = g.clouds();
    g.game.cameraMode = "chase";
    return { bestD, inside, below };
  });
  expect(res.bestD).toBeGreaterThan(0.3);
  expect(res.inside.density).toBeGreaterThan(0.2);
  expect(res.inside.veil).toBeGreaterThan(0.2);
  expect(res.below.density).toBe(0);
  expect(res.below.veil).toBeLessThan(0.05);
  expectNoErrors(shared.errors());
});

test("quality tiers cycle with H and every tier renders", async () => {
  const page = shared.page();
  const tiers: string[] = [];
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("h");
    tiers.push(
      await page.evaluate(() => {
        const g = (window as any).__game;
        g.render();
        return g.quality();
      }),
    );
  }
  expect(tiers).toEqual(["high", "balanced", "lite", "ultra"]);
  expectNoErrors(shared.errors());
});

test("the star sits on the light axis and the sky darkens at night", async () => {
  const page = shared.page();
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    g.reset();
    g.render();
    const day = g.game.lighting.state.skyBrightness;
    const sunDir = g.game.lighting.sun.direction.clone().normalize();
    const toStar = g.views.get("vesper").root.position.clone().normalize();
    g.step(600); // ~half a day later: night
    g.render();
    const night = g.game.lighting.state.skyBrightness;
    return { day, night, align: sunDir.dot(toStar) };
  });
  expect(res.align).toBeCloseTo(-1, 3); // light travels away from the star
  expect(res.day).toBeGreaterThan(0.5);
  expect(res.night).toBeLessThan(0.1);
  expectNoErrors(shared.errors());
});
