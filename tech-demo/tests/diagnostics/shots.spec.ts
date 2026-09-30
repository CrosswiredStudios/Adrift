/**
 * Screenshot tour (no assertions): run with `npm run test:shots` and look at
 * test-results/shots/*.png after rendering or content changes.
 */
import { test } from "@playwright/test";
import { boot, waitSettled } from "../helpers";

interface Shot {
  name: string;
  /** Runs in the page with `g = window.__game`. */
  setup: string;
  /** Wait for terrain streaming before the shot. */
  settle?: boolean;
}

const SHOTS: Shot[] = [
  { name: "01-crash-site", setup: "g.reset();", settle: true },
  {
    name: "02-skiff-chase",
    setup:
      "g.reset(); g.setMode('ship'); g.input.setAxis('thrustY', 1); g.step(2); g.input.setAxis('thrustY', undefined); g.step(2);",
    settle: true,
  },
  {
    name: "03-coast-low",
    setup: "g.placeShip('vael', 26.2, 95.4, 60, 250); g.setMode('ship');",
    settle: true,
  },
  { name: "04-above-clouds", setup: "g.placeShip('vael', 26.5, 96, 1200, 0); g.setMode('ship');" },
  { name: "05-orbit-vael", setup: "g.placeShip('vael', 10, 96, 3500, 90); g.setMode('ship');" },
  {
    name: "06-tethys-surface",
    setup: "g.placeShip('tethys', 12, 8, 25, 180); g.setMode('ship');",
    settle: true,
  },
  {
    name: "07-cinder-haze",
    setup: "g.placeShip('cinder', -8, 42, 80, 90); g.setMode('ship');",
    settle: true,
  },
  { name: "08-vael-night", setup: "g.reset(); g.step(60 * 9);", settle: true },
];

test.describe.configure({ mode: "serial" });

test("screenshot tour", async ({ page }) => {
  test.setTimeout(SHOTS.length * 300000);
  await boot(page);
  await page.evaluate(() => (window as any).__game.freeze());
  for (const s of SHOTS) {
    await page.evaluate(`(() => { const g = window.__game; ${s.setup} g.render(); })()`);
    if (s.settle) await waitSettled(page, 240000);
    for (let i = 0; i < 3; i++) await page.evaluate(() => (window as any).__game.render());
    await page.screenshot({ path: `test-results/shots/${s.name}.png` });
  }
});
