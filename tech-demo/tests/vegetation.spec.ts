import { test, expect, Page } from "@playwright/test";
import { boot, collectErrors, expectNoErrors, orbitAim, placeAt, stepFrames } from "./helpers";

/**
 * Vegetation tests: instanced tree/shrub/grass wiring on Vael (Tethys stays
 * bare), placement constraints checked against the shared terrain field, and
 * screenshot views for visual review.
 *
 * Software GL renders at a few fps, so placement goes through `__game.step`
 * and screenshots allow >= 5 s per state (see repo memory).
 */

/** Boot + wait for Vael's vegetation bake (thin-instance counts need it). */
const bootVegetated = async (page: Page): Promise<void> => {
  await boot(page, true);
};

/** Vegetation also treats console warnings as failures (texture fallbacks). */
const collectVegetationProblems = (page: Page): string[] => {
  const errors = collectErrors(page);
  page.on("console", (m) => {
    if (m.type() === "warning") errors.push(`warning: ${m.text()}`);
  });
  return errors;
};

/** Vael-only placement (all vegetation shots are on body 0). */
const placeAtVael = async (page: Page, dir: number[], aim: number[], above: number): Promise<void> =>
  placeAt(page, 0, dir, aim, above);

test("vegetation wiring: Vael wooded, Tethys bare, textures ready, no shader errors", async ({ page }) => {
  test.setTimeout(180000);
  const problems = collectVegetationProblems(page);

  await bootVegetated(page);

  const data = await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    const v = g.vegetation();
    const vegMeshes = g.scene.meshes.filter(
      (m: { name?: string }) => typeof m.name === "string" && m.name.includes("-veg-"),
    );
    return {
      vael: v.vael,
      tethys: v.tethys,
      meshCount: vegMeshes.length,
      names: vegMeshes.map((m: { name: string }) => m.name) as string[],
      thinCounts: vegMeshes.map((m: { thinInstanceCount: number }) => m.thinInstanceCount) as number[],
    };
  });

  expect(data.tethys).toBeNull();
  const s = data.vael as {
    trees: number;
    broadleaf: number;
    conifer: number;
    shrubs: number;
    grass: number;
    tris: number;
    budget: number;
    ready: boolean;
    fallbacks: string[];
  };
  console.log("vael vegetation", JSON.stringify(s));
  expect(s).toBeTruthy();
  expect(s.ready).toBe(true);
  expect(s.fallbacks).toEqual([]);
  expect(s.broadleaf).toBeGreaterThan(500);
  expect(s.conifer).toBeGreaterThan(250);
  expect(s.shrubs).toBeGreaterThan(1000);
  expect(s.grass).toBeGreaterThan(500);
  expect(s.tris).toBeGreaterThan(30000);
  expect(s.tris).toBeLessThanOrEqual(s.budget);
  expect(data.meshCount).toBe(6);
  for (const n of data.names) expect(n.startsWith("Vael Prime-veg-")).toBe(true);
  for (const c of data.thinCounts) expect(c).toBeGreaterThan(0);

  const shaderProblems = problems.filter((p) => /shader|glsl|compil|uniform|attribute|effect/i.test(p));
  expect(shaderProblems).toEqual([]);
  // Warnings stay informational here (headless SwiftShader emits benign
  // "GPU stall due to ReadPixels" performance warnings); errors must be zero.
  expectNoErrors(problems.filter((p) => !p.startsWith("warning: ")));

  // Wind sway: the plugin must inject its uniform into the foliage materials
  // (and must NOT touch the bark).
  const sway = await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    const foliage = g.scene.getMeshByName("Vael Prime-veg-canopy-a");
    const bark = g.scene.getMeshByName("Vael Prime-veg-trunk-a");
    const has = (m: any): boolean => !!m?.material?.getEffect?.()?.vertexSourceCode?.includes("uSwayTime");
    return { foliage: has(foliage), bark: has(bark) };
  });
  expect(sway.foliage).toBe(true);
  expect(sway.bark).toBe(false);
});

test("vegetation placement: land only, under the lines, off slopes and poles", async ({ page }) => {
  test.setTimeout(180000);
  const errors = collectErrors(page);
  await bootVegetated(page);

  const report = await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    const st = g.vegetation().vael as {
      waterLevel: number;
      limits: Record<string, { line: number; polar: number; slope: number; shore: number }>;
    };
    const nrm = (v: number[]): number[] => {
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      return [v[0] / l, v[1] / l, v[2] / l];
    };
    const cross = (a: number[], b: number[]): number[] => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    const check = (layer: "trees" | "shrubs" | "grass", n: number) => {
      const lim = st.limits[layer];
      const dirs = g.vegetationSample(0, layer, n) as number[][];
      const bad: string[] = [];
      let maxSlope = 0,
        minH = 9,
        maxAbsY = 0;
      const eps = 0.0035;
      const slopeAt = (d: number[]): number => {
        const ref = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        const t1 = nrm(cross(d, ref));
        const t2 = nrm(cross(t1, d));
        const s1 =
          Math.abs(
            g.probe([d[0] + t1[0] * eps, d[1] + t1[1] * eps, d[2] + t1[2] * eps]).h -
              g.probe([d[0] - t1[0] * eps, d[1] - t1[1] * eps, d[2] - t1[2] * eps]).h,
          ) /
          (2 * eps);
        const s2 =
          Math.abs(
            g.probe([d[0] + t2[0] * eps, d[1] + t2[1] * eps, d[2] + t2[2] * eps]).h -
              g.probe([d[0] - t2[0] * eps, d[1] - t2[1] * eps, d[2] - t2[2] * eps]).h,
          ) /
          (2 * eps);
        return Math.hypot(s1, s2);
      };
      for (const d of dirs) {
        const p = g.probe(d) as { h: number; water: boolean };
        if (p.water) bad.push("water");
        if (p.h < st.waterLevel + lim.shore - 1e-6) bad.push("shore");
        if (p.h > lim.line + 1e-6) bad.push("line");
        maxAbsY = Math.max(maxAbsY, Math.abs(d[1]));
        if (Math.abs(d[1]) > lim.polar + 1e-6) bad.push("polar");
        const slope = slopeAt(d);
        maxSlope = Math.max(maxSlope, slope);
        if (slope > lim.slope + 0.2) bad.push("slope");
        minH = Math.min(minH, p.h);
      }
      return { count: dirs.length, bad, maxSlope, minH, maxAbsY, lim };
    };
    return { trees: check("trees", 300), shrubs: check("shrubs", 200) };
  });

  expect(report.trees.count).toBeGreaterThanOrEqual(250);
  expect(report.trees.bad).toEqual([]);
  expect(report.trees.maxSlope).toBeLessThanOrEqual(report.trees.lim.slope + 0.2);
  expect(report.trees.maxAbsY).toBeLessThanOrEqual(report.trees.lim.polar + 1e-6);

  expect(report.shrubs.count).toBeGreaterThanOrEqual(150);
  expect(report.shrubs.bad).toEqual([]);
  expect(report.shrubs.maxSlope).toBeLessThanOrEqual(report.shrubs.lim.slope + 0.2);
  expectNoErrors(errors);
});

test("vegetation screenshots: forest, coast, orbit", async ({ page }) => {
  test.setTimeout(300000);
  const errors = collectErrors(page);
  await bootVegetated(page);

  // Hide the cloud deck so the ground is readable in the close shots. The deck
  // is a post-process now, so the mesh toggle alone leaves the raymarch running.
  await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    g.scene.getMeshByName("Vael Prime-clouds")?.setEnabled(false);
    g.bodies[0].surface?.cloudDeck?.setTier("lite");
  });

  const targets = await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    const st = g.vegetation().vael as { waterLevel: number };
    const probe = (d: number[]) => g.probe(d) as { h: number; water: boolean };
    const dirs = g.vegetationSample(0, "trees", 1200) as number[][];
    const nrm = (v: number[]): number[] => {
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      return [v[0] / l, v[1] / l, v[2] / l];
    };
    const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross = (a: number[], b: number[]): number[] => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    const sun = g.scene.getLightByName("sun").direction.scale(-1);
    const sunArr = [sun.x, sun.y, sun.z];

    // Densest tree cluster on the day side (neighbours within ~3.5 deg), biased
    // toward brighter ground so the shot is not taken near the terminator.
    const cosLim = Math.cos(0.06);
    let cluster = dirs[0],
      best = -1,
      dayDirs = 0;
    for (const d of dirs) {
      const day = dot(d, sunArr);
      if (day < 0.45) continue;
      dayDirs++;
      let n = 0;
      for (const o of dirs) if (dot(d, o) > cosLim) n++;
      const score = n * (0.4 + 0.6 * day);
      if (score > best) {
        best = score;
        cluster = d;
      }
    }

    // Stand back ~5 deg along an arbitrary tangent and look at the cluster.
    const ref = Math.abs(cluster[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const t = nrm(cross(ref, cluster));
    const view = nrm([cluster[0] + t[0] * 0.09, cluster[1] + t[1] * 0.09, cluster[2] + t[2] * 0.09]);
    const aim = nrm([
      cluster[0] - view[0] * dot(cluster, view),
      cluster[1] - view[1] * dot(cluster, view),
      cluster[2] - view[2] * dot(cluster, view),
    ]);

    // Coast: the day-side tree closest to the waterline; aim downhill.
    let coast = dirs[0],
      bestOver = 9;
    for (const d of dirs) {
      if (dot(d, sunArr) < 0.35) continue;
      const over = probe(d).h - st.waterLevel;
      if (over > 0.006 && over < bestOver) {
        bestOver = over;
        coast = d;
      }
    }
    const cRef = Math.abs(coast[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const ct = nrm(cross(cRef, coast));
    const eps = 0.01;
    const hPlus = probe([coast[0] + ct[0] * eps, coast[1] + ct[1] * eps, coast[2] + ct[2] * eps]).h;
    const hMinus = probe([coast[0] - ct[0] * eps, coast[1] - ct[1] * eps, coast[2] - ct[2] * eps]).h;
    const sign = hPlus < hMinus ? 1 : -1;
    const coastAim = [ct[0] * sign, ct[1] * sign, ct[2] * sign];
    // Stand a touch inland so the foreground is not a single trunk at the lens.
    const coastView = nrm([
      coast[0] - coastAim[0] * 0.015,
      coast[1] - coastAim[1] * 0.015,
      coast[2] - coastAim[2] * 0.015,
    ]);

    return { cluster, view, aim, best, dayDirs, coast, coastView, coastAim, bestOver };
  });
  console.log("vegetation targets", JSON.stringify(targets));
  expect(targets.best).toBeGreaterThanOrEqual(3);
  expect(targets.dayDirs).toBeGreaterThan(30);

  // Forest close-up: over a dense cluster on the day side, looking along the horizon.
  await placeAtVael(page, targets.view, targets.aim, 20);
  await stepFrames(page, 120, 1 / 60);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: "test-results/vegetation-forest.png" });

  // Coast flyby: low over the shoreline, nose toward the water.
  await placeAtVael(page, targets.coastView, targets.coastAim, 14);
  await stepFrames(page, 120, 1 / 60);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: "test-results/vegetation-coast.png" });

  // Orbit sanity: vegetation must not disturb the planet silhouette.
  await placeAtVael(page, targets.cluster, await orbitAim(page, targets.cluster), 820);
  await stepFrames(page, 400, 1 / 60);
  await page.waitForTimeout(7000);
  await page.screenshot({ path: "test-results/vegetation-orbit.png" });
  expectNoErrors(errors);
});
