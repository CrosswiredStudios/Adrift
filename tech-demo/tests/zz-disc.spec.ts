import { test } from "@playwright/test";
import { boot } from "./helpers";

test("identify white disc", async ({ page }) => {
  test.setTimeout(180000);
  await boot(page);
  await page.waitForTimeout(3000);
  const proj = await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    const cam = g.camera;
    const out: any = {};
    const targets: any = {
      sol: g.sun.body.center,
      tethys: g.bodies[1].center,
      vael: g.bodies[0].center,
    };
    for (const [k, c] of Object.entries(targets)) {
      const v = (c as any).subtract(cam.position);
      const dist = v.length();
      const dir = v.scale(1 / dist);
      const fwd = cam.getForwardRay().direction.normalize();
      const dot = dir.dot(fwd);
      out[k] = { dist: Math.round(dist), dot: +dot.toFixed(3) };
    }
    out.camPos = cam.position.asArray().map((n: number) => Math.round(n));
    out.camFwd = cam.getForwardRay().direction.asArray().map((n: number) => +n.toFixed(3));
    return out;
  });
  console.log("proj " + JSON.stringify(proj));
  await page.screenshot({ path: "test-results/disc-base.png" });
  // Hide Tethys ground -> if disc vanishes, it was the moon
  await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    g.bodies[1].mesh.setEnabled(false);
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "test-results/disc-no-tethys.png" });
  await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    g.bodies[1].mesh.setEnabled(true);
    g.sun.core.setEnabled(false);
    (g.sun as any).corona.setEnabled(false);
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "test-results/disc-no-sun.png" });
  await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    g.sun.core.setEnabled(true);
    (g.sun as any).corona.setEnabled(true);
    (g.bodies[0] as any).atmosphere?.inner.setEnabled(false);
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "test-results/disc-no-dome.png" });
});
