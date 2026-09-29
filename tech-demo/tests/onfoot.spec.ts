import { test, expect } from "@playwright/test";
import { expectNoErrors, sharedGame } from "./helpers";

const shared = sharedGame();

test("walks over the terrain, staying on the ground", async () => {
  const page = shared.page();
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    g.freeze();
    g.reset();
    const p0 = g.sim.player.pos.clone();
    g.input.setAxis("moveZ", 1);
    let maxGap = 0;
    for (let i = 0; i < 300; i++) {
      g.step(1 / 60);
      maxGap = Math.max(maxGap, Math.abs(g.sim.player.altitude));
    }
    g.input.setAxis("moveZ", undefined);
    g.step(0.5);
    return {
      walked: g.sim.player.pos.subtract(p0).length(),
      maxGap,
      grounded: g.sim.player.grounded,
      speed: g.sim.player.vel.length(),
    };
  });
  expect(res.walked).toBeGreaterThan(15); // ~4 m/s for 5 s (uphill slows nothing)
  expect(res.walked).toBeLessThan(24);
  expect(res.maxGap).toBeLessThan(0.6); // no bouncing off slopes
  expect(res.grounded).toBe(true);
  expect(res.speed).toBeLessThan(0.3); // stops when released
  expectNoErrors(shared.errors());
});

test("jumps and lands", async () => {
  const page = shared.page();
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    g.reset();
    g.input.setButton("jump", true);
    g.step(1 / 60);
    g.input.setButton("jump", undefined);
    let peak = 0;
    for (let i = 0; i < 120; i++) {
      g.step(1 / 60);
      peak = Math.max(peak, g.sim.player.altitude);
    }
    return { peak, grounded: g.sim.player.grounded };
  });
  expect(res.peak).toBeGreaterThan(0.7);
  expect(res.peak).toBeLessThan(1.6);
  expect(res.grounded).toBe(true);
  expectNoErrors(shared.errors());
});

test("walk to the skiff, board it with F, step out again", async () => {
  const page = shared.page();
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    g.reset();
    const sim = g.sim;
    // Stand 3 m from the hatch, facing it.
    const hatch = sim.hatchPosition();
    const up = hatch.clone().normalize();
    const side = sim.ship.axis(new hatch.constructor(-1, 0, 0));
    const spot = hatch.add(side.scale(3)).normalize();
    sim.player.placeOnSurface(spot, side.scale(-1), sim.env(sim.playerBody));
    g.step(1 / 60);
    const prompt = document.querySelector(".hud-prompt")?.textContent;
    const canBoard = sim.canBoard();
    g.input.setButton("interact", true);
    g.step(1 / 60);
    g.input.setButton("interact", undefined);
    const modeAfterBoard = g.mode();
    g.step(1);
    // Parked on the pad: step out.
    g.input.setButton("interact", true);
    g.step(1 / 60);
    g.input.setButton("interact", undefined);
    g.step(0.5);
    const dist = sim.player.pos.subtract(sim.ship.pos).length();
    return { canBoard, modeAfterBoard, modeAfterExit: g.mode(), dist, up: up.length(), prompt };
  });
  expect(res.canBoard).toBe(true);
  expect(res.modeAfterBoard).toBe("ship");
  expect(res.modeAfterExit).toBe("onFoot");
  expect(res.dist).toBeGreaterThan(2);
  expect(res.dist).toBeLessThan(8);
  expectNoErrors(shared.errors());
});

test("static props block the player", async () => {
  const page = shared.page();
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    g.reset();
    const sim = g.sim;
    const pod = g.game.placedPois.get("pod");
    // Start 8 m in front of the pod and walk straight at it.
    const start = pod.origin.add(pod.forward.scale(8)).normalize();
    sim.player.placeOnSurface(start, pod.forward.scale(-1), sim.env(sim.playerBody));
    g.input.setAxis("moveZ", 1);
    g.step(6);
    g.input.setAxis("moveZ", undefined);
    const toPod = sim.player.pos.subtract(pod.origin);
    const along = toPod.dot(pod.forward);
    return { along };
  });
  // The pod's collider reaches 2.3 m along its axis; we stop outside it.
  expect(res.along).toBeGreaterThan(2.3);
  expectNoErrors(shared.errors());
});
