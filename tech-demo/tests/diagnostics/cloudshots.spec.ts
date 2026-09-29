import { test } from "@playwright/test";
import { boot, orbitAim, placeAt, stepFrames } from "../helpers";
test("cloud screenshots", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await boot(page);
  // Orbit view: ship above the deck looking down at an angle.
  const dir = await page.evaluate(() => {
    const g = (window as any).__game;
    const deck = g.bodies[0].surface.cloudDeck;
    const center = deck.center();
    const V = center.constructor as new (x: number, y: number, z: number) => any;
    const mid = (deck.bounds.innerR + deck.bounds.outerR) / 2;
    let best: any = null;
    let bestD = -1;
    for (let i = 0; i < 400; i++) {
      const u = (i * 0.6180339887) % 1;
      const v = (i * 0.7548776662) % 1;
      const phi = u * Math.PI * 2;
      const cosT = 1 - 2 * v;
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const d = new V(sinT * Math.cos(phi), cosT, sinT * Math.sin(phi));
      const dens = deck.sample(center.add(d.scale(mid)), 0);
      if (dens > bestD) {
        bestD = dens;
        best = d.asArray();
      }
    }
    return best;
  });
  const aim = await orbitAim(page, dir);
  await placeAt(page, 0, dir, aim, 120);
  await stepFrames(page, 10, 1 / 60);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: "test-results/cloud-orbit.png" });
  // Low view just above the deck.
  await placeAt(page, 0, dir, aim, 30);
  await stepFrames(page, 10, 1 / 60);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: "test-results/cloud-low.png" });
  // Inside the deck: park the camera mid-slab.
  await page.evaluate((dd: number[]) => {
    const g = (window as any).__game;
    const deck = g.bodies[0].surface.cloudDeck;
    const mid = (deck.bounds.innerR + deck.bounds.outerR) / 2;
    const center = deck.center();
    const V = center.constructor as new (x: number, y: number, z: number) => any;
    const d = new V(dd[0], dd[1], dd[2]).normalize();
    g.camera.position.copyFrom(center).addInPlace(d.scale(mid));
  }, dir);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: "test-results/cloud-inside.png" });
});
