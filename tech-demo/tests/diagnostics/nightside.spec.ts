import { test } from "@playwright/test";
import { boot, collectErrors, expectNoErrors, placeAt, stepFrames } from "../helpers";

test("night side debug", async ({ page }) => {
  test.setTimeout(180000);
  const errors = collectErrors(page);
  await boot(page);
  await page.waitForFunction(
    () => {
      const t = (window as unknown as { __game: any }).__game.terrain();
      return t.vael?.ready === true;
    },
    null,
    { timeout: 30000 },
  );
  // Find land directions on day and night sides
  const targets = await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    const probe = (d: number[]) => g.probe(d) as { h: number; water: boolean };
    const sun: any = g.scene.getLightByName("sun").direction.scale(-1);
    const sunArr = [sun.x, sun.y, sun.z];
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const at = (i: number): number[] => {
      const u = (i * 0.6180339887) % 1;
      const v = (i * 0.7548776662) % 1;
      const phi = u * Math.PI * 2;
      const cosT = 1 - 2 * v;
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      return [sinT * Math.cos(phi), cosT, sinT * Math.sin(phi)];
    };
    let dayLand: number[] | null = null;
    let nightLand: number[] | null = null;
    let dayDotBest = -2;
    let nightDotBest = 2;
    for (let i = 0; i < 20000; i++) {
      const d = at(i);
      const p = probe(d);
      if (p.water || p.h < 0.05 || p.h > 0.4) continue;
      const s = dot(d, sunArr);
      if (s > 0.7 && (dayLand === null || s > dayDotBest)) {
        dayDotBest = s;
        dayLand = d;
      }
      if (s < -0.7 && (nightLand === null || s < nightDotBest)) {
        nightDotBest = s;
        nightLand = d;
      }
    }
    return { dayLand, nightLand, dayDotBest, nightDotBest };
  });
  console.log("targets", JSON.stringify(targets));

  const orbitAimFor = async (dir: number[]) => {
    return page.evaluate((d: number[]) => {
      const ref = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const t = [ref[1] * d[2] - ref[2] * d[1], ref[2] * d[0] - ref[0] * d[2], ref[0] * d[1] - ref[1] * d[0]];
      const tl = Math.hypot(t[0], t[1], t[2]) || 1;
      return [
        -d[0] * 0.966 + (t[0] / tl) * 0.259,
        -d[1] * 0.966 + (t[1] / tl) * 0.259,
        -d[2] * 0.966 + (t[2] / tl) * 0.259,
      ];
    }, dir);
  };

  // Day shot
  await placeAt(page, 0, targets.dayLand!, await orbitAimFor(targets.dayLand!), 820);
  await stepFrames(page, 200, 1 / 60);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: "test-results/night-day.png" });

  // Night shot (clouds on)
  await placeAt(page, 0, targets.nightLand!, await orbitAimFor(targets.nightLand!), 820);
  await stepFrames(page, 200, 1 / 60);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: "test-results/night-night.png" });

  // Night shot, clouds hidden + night lights hidden, to isolate ground
  await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    g.scene.getMeshByName("Vael Prime-clouds")?.setEnabled(false);
    g.scene.getMeshByName("Vael Prime-night-shell")?.setEnabled(false);
    g.cloudQuality("lite");
  });
  await stepFrames(page, 60, 1 / 60);
  await page.waitForTimeout(5000);
  await page.screenshot({ path: "test-results/night-night-bare.png" });

  // Sample center pixel brightness via screenshot pixels? Instead read ground material info
  const info = await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    const hemi = g.scene.getLightByName("hemi");
    const sun = g.scene.getLightByName("sun");
    return {
      hemiIntensity: hemi.intensity,
      hemiDiffuse: hemi.diffuse.asArray(),
      sunIntensity: sun.intensity,
      sunDiffuse: sun.diffuse.asArray(),
      daylight: g.state.atmoDensity,
    };
  });
  console.log("lights", JSON.stringify(info));
  expectNoErrors(errors);
});
