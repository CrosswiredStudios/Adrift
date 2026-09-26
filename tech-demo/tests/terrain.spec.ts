import { test, expect, Page } from "@playwright/test";

/**
 * Terrain tests: ground texture blend wiring (grass/rock by slope + altitude),
 * dramatic relief, tiled terrain UVs, and screenshot views for visual review.
 *
 * Headless software GL renders at a few fps, so placement goes through
 * `__game.step` and screenshots allow >= 5 s per state (see repo memory).
 */

type Dir = number[];

const stepFrames = async (page: Page, frames: number, dt: number): Promise<void> => {
  await page.evaluate(
    ([n, h]) => {
      const g = (window as unknown as { __game: any }).__game;
      for (let i = 0; i < (n as number); i++) g.step(h as number);
    },
    [frames, dt]
  );
};

/** Place the ship (camera follows) at `dir`, `above` sea-radius units up, aimed along `aim`. */
const placeAt = async (page: Page, dir: Dir, aim: Dir, above: number): Promise<void> => {
  await page.evaluate(
    ([dAr, aAr, alt]) => {
      const g = (window as unknown as { __game: any }).__game;
      const body = g.bodies[0];
      const V = body.center.constructor as new (x: number, y: number, z: number) => any;
      const d = new V(dAr[0], dAr[1], dAr[2]).normalize();
      const a = new V(aAr[0], aAr[1], aAr[2]).normalize();
      const probe = g.probe(d.asArray());
      g.ship.position.copyFrom(body.center).addInPlace(d.scale(probe.seaRadius + alt));
      g.state.landed = false;
      g.state.floating = false;
      // NB: FromLookDirectionLH aims the local -Z at the target, so negate.
      const Q = g.ship.rotationQuaternion.constructor as any;
      g.ship.rotationQuaternion.copyFrom(Q.FromLookDirectionLH(a.scale(-1), d));
    },
    [dir, aim, above]
  );
};

/**
 * Nose direction for an orbit view: ~15 deg off straight-down. Looking exactly
 * down the local vertical makes the chase camera's horizon-stable up-vector
 * degenerate (up target parallel to the view), which frames erratically.
 */
const orbitAim = async (page: Page, dir: Dir): Promise<Dir> =>
  page.evaluate((d: number[]) => {
    const ref = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const t = [
      ref[1] * d[2] - ref[2] * d[1],
      ref[2] * d[0] - ref[0] * d[2],
      ref[0] * d[1] - ref[1] * d[0],
    ];
    const tl = Math.hypot(t[0], t[1], t[2]) || 1;
    const v = [
      -d[0] * 0.966 + (t[0] / tl) * 0.259,
      -d[1] * 0.966 + (t[1] / tl) * 0.259,
      -d[2] * 0.966 + (t[2] / tl) * 0.259,
    ];
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }, dir);

test("ground textures: plugin attached, textures load, no shader errors", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });

  await page.goto("/", { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => (window as unknown as { __game?: unknown }).__game !== undefined,
    null,
    { timeout: 15000 }
  );
  await page.waitForFunction(
    () => {
      const t = (window as unknown as { __game: any }).__game.terrain();
      return t.vael?.ready === true && t.tethys?.ready === true;
    },
    null,
    { timeout: 30000 }
  );

  const info = await page.evaluate(() => (window as unknown as { __game: any }).__game.terrain());
  expect(info.vael.fallbacks).toEqual([]);
  expect(info.tethys.fallbacks).toEqual([]);
  expect(info.vael.snowStart).toBeGreaterThan(0);
  expect(info.tethys.snowStart).toBeNull();

  // Structural wiring: plugin present on both ground materials, tiled UVs on
  // the Vael mesh (193 x 193 vertices at 192 segments), relief raised.
  const structural = await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    const vael = g.scene.getMeshByName("Vael Prime-ground");
    const tethys = g.scene.getMeshByName("Tethys-ground");
    return {
      vaelPlugin: !!vael.material.pluginManager.getPlugin("TerrainTextures"),
      tethysPlugin: !!tethys.material.pluginManager.getPlugin("TerrainTextures"),
      uvCount: vael.getVerticesData("terrainUv")?.length ?? 0,
      vaelRelief: g.bodies[0].relief,
      tethysRelief: g.bodies[1].relief,
    };
  });
  expect(structural.vaelPlugin).toBe(true);
  expect(structural.tethysPlugin).toBe(true);
  expect(structural.uvCount).toBe(193 * 193 * 2);
  expect(structural.vaelRelief).toBeCloseTo(0.045, 5);
  expect(structural.tethysRelief).toBeCloseTo(0.05, 5);

  // Shader-compile failures surface as console errors mentioning the program.
  const shaderErrors = problems.filter((p) => /shader|glsl|compil|uniform|attribute|effect/i.test(p));
  expect(shaderErrors).toEqual([]);
});

test("terrain relief: mountain ranges, crags, oceans", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => (window as unknown as { __game?: unknown }).__game !== undefined,
    null,
    { timeout: 15000 }
  );

  const scan = await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    const probe = (d: number[]) => g.probe(d) as { h: number; water: boolean };
    let maxH = -9, minH = 9, water = 0;
    const n = 8000;
    for (let i = 0; i < n; i++) {
      const u = (i * 0.6180339887) % 1;
      const v = (i * 0.7548776662) % 1;
      const phi = u * Math.PI * 2;
      const cosT = 1 - 2 * v;
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const d = [sinT * Math.cos(phi), cosT, sinT * Math.sin(phi)];
      const p = probe(d);
      maxH = Math.max(maxH, p.h);
      minH = Math.min(minH, p.h);
      if (p.water) water++;
    }
    return { maxH, minH, waterFrac: water / n };
  });
  console.log("terrain scan", JSON.stringify(scan));

  // Mountain ranges reach well above the old uniform FBM ceiling (~0.8 here),
  // while the sea still covers a healthy fraction of the sphere.
  expect(scan.maxH).toBeGreaterThan(1.0);
  expect(scan.waterFrac).toBeGreaterThan(0.05);
  expect(scan.waterFrac).toBeLessThan(0.95);
});

test("terrain screenshots: orbit, range, cliff, blend mask", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/", { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => (window as unknown as { __game?: unknown }).__game !== undefined,
    null,
    { timeout: 15000 }
  );
  await page.waitForFunction(
    () => {
      const t = (window as unknown as { __game: any }).__game.terrain();
      return t.vael?.ready === true;
    },
    null,
    { timeout: 30000 }
  );

  // Hide the cloud deck so the ground is readable in the shots.
  await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    g.scene.getMeshByName("Vael Prime-clouds")?.setEnabled(false);
  });

  // Find the brightest lowland (subsolar side), the tallest peak near it, and
  // the steepest slope in the bright cap. All views are anchored on lit ground.
  const targets = await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    const probe = (d: number[]) => g.probe(d) as { h: number; water: boolean };
    const sun = g.scene.getLightByName("sun").direction.scale(-1);
    const nrm = (v: number[]) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const mul = (a: number[], k: number) => [a[0] * k, a[1] * k, a[2] * k];
    const at = (i: number): number[] => {
      const u = (i * 0.6180339887) % 1;
      const v = (i * 0.7548776662) % 1;
      const phi = u * Math.PI * 2;
      const cosT = 1 - 2 * v;
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      return [sinT * Math.cos(phi), cosT, sinT * Math.sin(phi)];
    };
    const sunArr = [sun.x, sun.y, sun.z];

    // Pass 1: brightest lowland + steepest slope (both in the day cap).
    let anchor: number[] = [0, 1, 0], bestDay = -1;
    let cliffDir: number[] = [0, 1, 0], cliffSlope = 0, cliffH = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const d = at(i);
      const dayDot = dot(d, sunArr);
      if (dayDot < 0.6) continue;
      const p = probe(d);
      if (p.h > 0.02 && p.h < 0.45 && dayDot > bestDay) { bestDay = dayDot; anchor = d; }
      if (p.h < 0.2 || dayDot < 0.7) continue;
      const ref: number[] = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const t = nrm([ref[1] * d[2] - ref[2] * d[1], ref[2] * d[0] - ref[0] * d[2], ref[0] * d[1] - ref[1] * d[0]]);
      const eps = 0.004;
      const s = Math.abs(probe([d[0] + t[0] * eps, d[1] + t[1] * eps, d[2] + t[2] * eps]).h
                         - probe([d[0] - t[0] * eps, d[1] - t[1] * eps, d[2] - t[2] * eps]).h) / (2 * eps);
      if (s > cliffSlope) { cliffSlope = s; cliffDir = d; cliffH = p.h; }
    }

    // Pass 2: tallest point within ~0.3 rad of the anchor.
    const cosLim = Math.cos(0.3);
    let peak = anchor, peakH = -9;
    for (let i = 0; i < N; i++) {
      const d = at(i);
      if (dot(d, anchor) < cosLim) continue;
      const p = probe(d);
      if (p.h > peakH) { peakH = p.h; peak = d; }
    }

    // Stand back from the peak and look along the horizon at it.
    const tPeak = nrm(sub(peak, mul(anchor, dot(peak, anchor))));
    const view = nrm(sub(anchor, mul(tPeak, 0.1)));
    const aim = nrm(sub(peak, mul(view, dot(peak, view))));
    // Cliff: stand back a little and look at the steepest face.
    const tCliff = nrm(sub(cliffDir, mul(anchor, dot(cliffDir, anchor))));
    const cliffView = nrm(sub(cliffDir, mul(tCliff, 0.035)));
    const cliffAim = nrm(sub(cliffDir, mul(cliffView, dot(cliffDir, cliffView))));

    return { anchor, view, aim, peakH, cliffView, cliffAim, cliffSlope, cliffH, bestDay };
  });
  console.log("terrain targets", JSON.stringify(targets));
  expect(targets.peakH).toBeGreaterThan(0.8);
  expect(targets.cliffSlope).toBeGreaterThan(1.0);

  // Orbit: over the brightest region looking down at the day side.
  await placeAt(page, targets.anchor, await orbitAim(page, targets.anchor), 820);
  await stepFrames(page, 400, 1 / 60);
  await page.waitForTimeout(7000);
  await page.screenshot({ path: "test-results/terrain-orbit.png" });

  // Range: stand back from the peak at low altitude, aimed at it.
  await placeAt(page, targets.view, targets.aim, 26);
  await stepFrames(page, 120, 1 / 60);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: "test-results/terrain-range.png" });

  // Cliff: the steepest slope from close range.
  await placeAt(page, targets.cliffView, targets.cliffAim, 16);
  await stepFrames(page, 120, 1 / 60);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: "test-results/terrain-cliff.png" });

  // Debug masks from the same viewpoint as the range shot, so the grass/rock
  // split can be compared against the beauty frame: 1 = rock factor, 2 = slope.
  for (const mode of [1, 2]) {
    await page.evaluate((m) => (window as unknown as { __game: any }).__game.terrainDebug(m), mode);
    await placeAt(page, targets.view, targets.aim, 26);
    await stepFrames(page, 120, 1 / 60);
    await page.waitForTimeout(6000);
    await page.screenshot({ path: `test-results/terrain-mask${mode}.png` });
  }
  await page.evaluate(() => (window as unknown as { __game: any }).__game.terrainDebug(0));

  // Tethys: the rock + dust pair on the airless moon, viewed over the subsolar
  // point (no atmosphere, so the sun side is the whole show).
  await page.evaluate((aimAr) => {
    const g = (window as unknown as { __game: any }).__game;
    const body = g.bodies[1];
    const sun = g.scene.getLightByName("sun").direction.scale(-1);
    const V = body.center.constructor as new (x: number, y: number, z: number) => any;
    const d = new V(sun.x, sun.y, sun.z).normalize();
    const aim = new V(aimAr[0], aimAr[1], aimAr[2]);
    g.ship.position.copyFrom(body.center).addInPlace(d.scale(body.radius + 120));
    g.state.landed = false;
    g.state.floating = false;
    const Q = g.ship.rotationQuaternion.constructor as any;
    g.ship.rotationQuaternion.copyFrom(Q.FromLookDirectionLH(aim.scale(-1), d));
    const before = g.ship.position.subtract(body.center).length();
    for (let i = 0; i < 400; i++) g.step(1 / 60);
    const after = g.ship.position.subtract(body.center).length();
    // Regression guard: the wave-float tracker must not carry over from Vael,
    // which used to snap the ship out to the previous planet's waterline.
    if (after > before + 5) throw new Error(`float tracker leaked across bodies: ${before} -> ${after}`);
  }, await orbitAim(page, await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    const sun = g.scene.getLightByName("sun").direction.scale(-1);
    return [sun.x, sun.y, sun.z];
  })));
  await page.waitForTimeout(7000);
  await page.screenshot({ path: "test-results/terrain-tethys.png" });
});
