import { test, expect } from "@playwright/test";
import { expectNoErrors, sharedGame } from "./helpers";

const shared = sharedGame();

test("keys map to actions by physical position and blur releases them", async () => {
  const page = shared.page();
  await page.evaluate(() => (window as any).__game.freeze());
  await page.keyboard.down("w");
  await page.keyboard.down("d");
  const held = await page.evaluate(() => {
    const g = (window as any).__game;
    g.step(1 / 60);
    return { moveZ: g.input.axis("moveZ"), moveX: g.input.axis("moveX"), thrustZ: g.input.axis("thrustZ") };
  });
  expect(held).toEqual({ moveZ: 1, moveX: 1, thrustZ: 1 });
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const released = await page.evaluate(() => {
    const g = (window as any).__game;
    g.step(1 / 60);
    return g.input.axis("moveZ");
  });
  expect(released).toBe(0);
  await page.keyboard.up("w");
  await page.keyboard.up("d");
  expectNoErrors(shared.errors());
});

test("a tap between two sim steps still registers (edge detection)", async () => {
  const page = shared.page();
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    g.reset();
    g.setMode("ship");
    const before = g.sim.ship.assist;
    // Key down + up before the next step: T toggles flight assist.
    g.input.setKey("KeyT", true);
    g.input.setKey("KeyT", false);
    g.step(1 / 60);
    const after = g.sim.ship.assist;
    g.step(1 / 60); // no second toggle
    return { before, after, later: g.sim.ship.assist };
  });
  expect(res.before).toBe(true);
  expect(res.after).toBe(false);
  expect(res.later).toBe(false);
  expectNoErrors(shared.errors());
});

test("mouse flight: pointer-lock motion pushes a self-centering stick", async () => {
  const page = shared.page();
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    g.reset();
    g.setMode("ship");
    g.input.addMouseDelta(80, 0);
    g.step(1 / 60);
    const yaw = g.sim.shipControls.rotate.y;
    for (let i = 0; i < 120; i++) g.step(1 / 60);
    return { yaw, after: g.sim.shipControls.rotate.y };
  });
  expect(res.yaw).toBeGreaterThan(0.2); // mouse right = yaw right
  expect(Math.abs(res.after)).toBeLessThan(0.02); // recentred
  expectNoErrors(shared.errors());
});
