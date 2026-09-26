import { test, expect } from "@playwright/test";
import { boot, collectErrors, expectNoErrors, placeAt, stepFrames } from "./helpers";

// Volumetric cloud deck: tier cycling, fly-through density, view obstruction.
test("cloud tiers cycle from ultra and lite disables the deck", async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    const seen: string[] = [g.clouds().tier];
    for (let i = 0; i < 4; i++) seen.push(g.cloudQuality());
    // The deck is a camera post-process now: lite detaches it, ultra
    // re-attaches it. Tracked via the deck's enabled flag (Babylon nulls the
    // camera slot on detach and appends on re-attach).
    g.cloudQuality("lite");
    const liteAttached = g.bodies[0].surface.cloudDeck.enabled;
    g.cloudQuality("ultra");
    const ultraAttached = g.bodies[0].surface.cloudDeck.enabled;
    return { seen, liteAttached, ultraAttached, tier: g.clouds().tier };
  });
  expect(res.seen[0]).toBe("ultra");
  expect(res.seen.slice(1)).toEqual(["high", "balanced", "lite", "ultra"]);
  expect(res.liteAttached).toBe(false);
  expect(res.ultraAttached).toBe(true);
  expect(res.tier).toBe("ultra");
  expectNoErrors(errors);
});

test("flying through the deck raises density and fog veil", async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  // Find a dense mid-slab point by scanning the CPU field from the page.
  const target = await page.evaluate(() => {
    const g = (window as any).__game;
    const deck = g.bodies[0].surface.cloudDeck;
    const center = deck.center();
    const V = center.constructor as new (x: number, y: number, z: number) => any;
    const mid = (deck.bounds.innerR + deck.bounds.outerR) / 2;
    let best: number[] | null = null;
    let bestD = -1;
    for (let i = 0; i < 400; i++) {
      const u = (i * 0.6180339887) % 1;
      const v = (i * 0.7548776662) % 1;
      const phi = u * Math.PI * 2;
      const cosT = 1 - 2 * v;
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const d = new V(sinT * Math.cos(phi), cosT, sinT * Math.sin(phi));
      const p = center.add(d.scale(mid));
      const dens = deck.sample(p, 0);
      if (dens > bestD) {
        bestD = dens;
        best = d.asArray();
      }
    }
    return {
      dir: best,
      density: bestD,
    };
  });
  expect(target.dir).not.toBeNull();
  expect(target.density).toBeGreaterThan(0.05);
  const dir = target.dir as number[];
  // Place the ship just above the deck looking down through it, then step in.
  const aim = [-dir[0], -dir[1], -dir[2]];
  await placeAt(page, 0, dir, aim, 60);
  await stepFrames(page, 30, 1 / 60);
  const before = await page.evaluate(() => (window as any).__game.clouds());
  // Teleport the ship into the densest slab point. Ground contact clamps the
  // ship to the surface, so sample the field directly at the slab point and
  // park the camera there (the veil samples the camera position). The deck
  // post-process is enabled (not lite), so the veil path is live.
  const slab = await page.evaluate((dd: number[]) => {
    const g = (window as any).__game;
    g.cloudQuality("ultra");
    const deck = g.bodies[0].surface.cloudDeck;
    const mid = (deck.bounds.innerR + deck.bounds.outerR) / 2;
    const center = deck.center();
    const V = center.constructor as new (x: number, y: number, z: number) => any;
    const d = new V(dd[0], dd[1], dd[2]).normalize();
    const p = center.add(d.scale(mid));
    g.camera.position.copyFrom(p);
    return { density: deck.sample(p, 0), camR: p.subtract(center).length() };
  }, dir);
  expect(slab.density).toBeGreaterThan(0.05);
  // NOTE: __game.step does not move the chase camera (cameraRig.update runs
  // only in the render loop), and the render loop re-parks the camera between
  // evaluates — so park + step atomically inside one evaluate, then re-park
  // once more before reading (the veil samples the camera position).
  await page.evaluate((dd: number[]) => {
    const g = (window as any).__game;
    const deck = g.bodies[0].surface.cloudDeck;
    const mid = (deck.bounds.innerR + deck.bounds.outerR) / 2;
    const center = deck.center();
    const V = center.constructor as new (x: number, y: number, z: number) => any;
    const d = new V(dd[0], dd[1], dd[2]).normalize();
    const park = () => g.camera.position.copyFrom(center).addInPlace(d.scale(mid));
    for (let i = 0; i < 120; i++) {
      park();
      g.step(1 / 60);
    }
    park();
  }, dir);
  const inside = await page.evaluate(() => ({
    clouds: (window as any).__game.clouds(),
    fog: (window as any).__game.scene.fogDensity,
  }));
  expect(inside.clouds.density).toBeGreaterThan(before.density);
  expect(inside.clouds.density).toBeGreaterThan(0.05);
  expect(inside.fog).toBeGreaterThan(0);
  expect(inside.clouds.veil).toBeGreaterThan(0);
  expectNoErrors(errors);
});
