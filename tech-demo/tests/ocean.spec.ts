import { test, expect } from "@playwright/test";

/**
 * Ocean tests. Flight/buoyancy run through `__game.step` (deterministic, no
 * rendering) because headless software GL renders at a few frames per second;
 * the coastal screenshots use real frames instead.
 *
 * Helpers live on `window.__ocean` inside the page so they can use the game's
 * own Vector3/Quaternion classes.
 */

interface Coast {
  dir: number[];
  landward: number[];
  h: number;
  seaRadius: number;
}

const INSTALL_HELPERS = (): void => {
  const g = (window as unknown as { __game: any }).__game;
  const body = g.bodies[0];
  const V = body.center.constructor as new (x: number, y: number, z: number) => any;
  const probe = (d: number[]) => g.probe(d) as { h: number; water: boolean; waterLevel: number; seaRadius: number };

  const sunToward = (): any => {
    const sun = g.scene.getLightByName("sun");
    return sun ? sun.direction.scale(-1) : null;
  };

  const scan = (accept: (p: { h: number; waterLevel: number }) => boolean): Coast | null => {
    const sun = sunToward();
    for (let i = 0; i < 20000; i++) {
      const u = (i * 0.6180339887) % 1;
      const v = (i * 0.7548776662) % 1;
      const phi = u * Math.PI * 2;
      const cosT = 1 - 2 * v;
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const d = [sinT * Math.cos(phi), cosT, sinT * Math.sin(phi)];
      const p = probe(d);
      if (!p.water || !accept(p)) continue;
      if (sun) {
        const dirV = new V(d[0], d[1], d[2]).normalize();
        if ((dirV as any).dot(sun) < 0.35) continue; // keep it on the day side
      }
      const dir = new V(d[0], d[1], d[2]).normalize();
      const ref = new V(Math.abs(dir.y) < 0.9 ? 0 : 1, Math.abs(dir.y) < 0.9 ? 1 : 0, 0);
      const t = ref.cross(dir).normalize();
      const eps = 0.004;
      const hPlus = probe(dir.add(t.scale(eps)).asArray()).h;
      const hMinus = probe(dir.subtract(t.scale(eps)).asArray()).h;
      const landward = hPlus > hMinus ? t : t.scale(-1);
      return { dir: dir.asArray(), landward: landward.asArray(), h: p.h, seaRadius: p.seaRadius };
    }
    return null;
  };

  const api = {
    /** Shallow water right at the shoreline, on the day side. */
    findCoast(band: number, depth: number): Coast | null {
      return scan((p) => p.h <= p.waterLevel - band && p.h > p.waterLevel - band - depth);
    },
    /** Deep open water on the day side. */
    findDeep(minDepth: number): Coast | null {
      return scan((p) => p.h < p.waterLevel - minDepth);
    },
    /** Unit direction `dist` world units offshore of a coast point. */
    offshore(c: Coast, dist: number): number[] {
      const dir = new V(c.dir[0], c.dir[1], c.dir[2]).normalize();
      const landward = new V(c.landward[0], c.landward[1], c.landward[2]).normalize();
      return dir.subtract(landward.scale(dist / body.radius)).normalize().asArray();
    },
    /** Place the ship at a sea point, nose aimed along `aimDir`. */
    placeAt(dirArr: number[], aimDir: number[], above: number): void {
      const dir = new V(dirArr[0], dirArr[1], dirArr[2]).normalize();
      const aim = new V(aimDir[0], aimDir[1], aimDir[2]).normalize();
      const radial = dir;
      g.ship.position.copyFrom(body.center).addInPlace(dir.scale(probe(dirArr).seaRadius + above));
      g.state.velocity.set(0, 0, 0);
      g.state.cruise = 0;
      g.state.landed = false;
      // NB: FromLookDirectionLH aims the local -Z at the target, so negate.
      const Q = g.ship.rotationQuaternion.constructor as any;
      g.ship.rotationQuaternion.copyFrom(Q.FromLookDirectionLH(aim.scale(-1), radial));
    },
    /** Camera altitude above the mean radius (no render frame in between). */
    cameraAtAlt(alt: number): void {
      const dir = g.ship.position.subtract(body.center).normalize();
      g.camera.position.copyFrom(body.center).addInPlace(dir.scale(body.radius + alt));
    },
  };
  (window as unknown as { __ocean: typeof api }).__ocean = api;
};

const stepFrames = async (page: import("@playwright/test").Page, frames: number, dt: number): Promise<void> => {
  await page.evaluate(
    ([n, h]) => {
      const g = (window as unknown as { __game: any }).__game;
      for (let i = 0; i < (n as number); i++) g.step(h as number);
    },
    [frames, dt]
  );
};

test("ocean attaches, patch follows altitude, ship floats on waves", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.waitForFunction(() => (window as unknown as { __game?: unknown }).__game !== undefined, null, { timeout: 30000 });
  await page.evaluate(INSTALL_HELPERS);

  const gating = await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    const patch = g.scene.getMeshByName("Vael Prime-ocean-patch");
    const camSaved = g.camera.position.clone();
    (window as unknown as { __ocean: any }).__ocean.cameraAtAlt(900);
    g.step(1 / 60);
    const high = patch.isEnabled();
    g.camera.position.copyFrom(camSaved);
    g.step(1 / 60);
    const low = patch.isEnabled();
    return { high, low };
  });
  expect(gating.low).toBe(true);
  expect(gating.high).toBe(false);

  const coast = await page.evaluate(() => (window as unknown as { __ocean: any }).__ocean.findCoast(0.02, 0.02));
  expect(coast).not.toBeNull();

  // Drop the ship onto the sea (soft landing) and let it float.
  await page.evaluate(
    (c) => (window as unknown as { __ocean: any }).__ocean.placeAt(c.dir, c.landward, 6),
    coast
  );
  await stepFrames(page, 300, 1 / 60);
  const floated = await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    return { floating: g.state.floating, landed: g.state.landed, alt: g.state.altitude };
  });
  expect(floated.floating).toBe(true);
  expect(floated.landed).toBe(true);
  expect(Math.abs(floated.alt - 1.2)).toBeLessThan(2.5); // rests on the wave surface

  // Frame-rate independence over water (buoyancy must be dt-correct).
  const drift = await page.evaluate((c) => {
    const g = (window as unknown as { __game: any }).__game;
    const api = (window as unknown as { __ocean: any }).__ocean;
    api.placeAt(c.dir, c.landward, 6);
    for (let i = 0; i < 240; i++) g.step(1 / 60);
    const a = g.ship.position.clone();
    api.placeAt(c.dir, c.landward, 6);
    for (let i = 0; i < 480; i++) g.step(1 / 120);
    const b = g.ship.position.clone();
    return a.subtract(b).length();
  }, coast);
  expect(drift).toBeLessThan(1.0);

  const stats = await page.evaluate(() => (window as unknown as { __game: any }).__game.ocean());
  expect(stats.vael.waveCount).toBeGreaterThan(4);
  expect(stats.vael.patchVerts).toBe(9409);
  console.log(JSON.stringify({ gating, floated, drift, stats }, null, 2));
});

test("coastal + open-water screenshots", async ({ page }) => {
  test.setTimeout(240000);
  await page.goto("/", { waitUntil: "networkidle" });
  await page.waitForFunction(() => (window as unknown as { __game?: unknown }).__game !== undefined, null, { timeout: 30000 });
  await page.evaluate(INSTALL_HELPERS);

  // Surf view: float just offshore and look back at the beach. NB: the cloud
  // deck sits only ~23 u above the surface, so shots must be taken from below.
  const coast = await page.evaluate(() => (window as unknown as { __ocean: any }).__ocean.findCoast(0.02, 0.02));
  expect(coast).not.toBeNull();
  const off = await page.evaluate((c) => (window as unknown as { __ocean: any }).__ocean.offshore(c, 60), coast);
  await page.evaluate(
    ([d, l]) => (window as unknown as { __ocean: any }).__ocean.placeAt(d as number[], l as number[], 3),
    [off, coast.landward]
  );
  await stepFrames(page, 240, 1 / 60);
  await page.waitForTimeout(5000);
  await page.screenshot({ path: "test-results/ocean-surf-a.png" });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: "test-results/ocean-surf-b.png" });

  // Open water: float on a deep basin looking along the waves.
  const deep = await page.evaluate(() => (window as unknown as { __ocean: any }).__ocean.findDeep(0.25));
  if (deep) {
    const tangent = await page.evaluate((c) => (window as unknown as { __ocean: any }).__ocean.offshore(c, 250), deep);
    await page.evaluate(
      ([d, a]) => (window as unknown as { __ocean: any }).__ocean.placeAt(d as number[], a as number[], 3),
      [deep.dir, tangent]
    );
    await stepFrames(page, 240, 1 / 60);
    await page.waitForTimeout(5000);
    await page.screenshot({ path: "test-results/ocean-deep.png" });
  }
  console.log("coast", JSON.stringify(coast), "deep", JSON.stringify(deep));

  // Orbit view: whole day-side disc — terrain relief and where the water is.
  await page.evaluate((c) => {
    const api = (window as unknown as { __ocean: any }).__ocean;
    const down = (c.dir as number[]).map((v) => -v);
    api.placeAt(c.dir, down, 780); // nose straight down at the planet
  }, coast);
  await page.waitForTimeout(7000);
  await page.screenshot({ path: "test-results/ocean-orbit.png" });
});
