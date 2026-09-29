import { test, expect } from "@playwright/test";
import { expectNoErrors, sharedGame } from "./helpers";

const shared = sharedGame();

test("boots clean and composes the Vesper Drift system", async () => {
  const page = shared.page();
  const snap = await page.evaluate(() => {
    const g = (window as any).__game;
    g.freeze();
    const pad = g.game.placedPois.get("pad");
    const shipToPad = g.sim.ship.pos.subtract(pad.origin).length();
    return {
      bodies: [...g.views.keys()],
      mode: g.mode(),
      shipBody: g.sim.shipBody.id,
      playerBody: g.sim.playerBody.id,
      shipLanded: g.sim.ship.landed,
      shipToPad,
      playerAlt: g.sim.player.altitude,
      terrain: g.terrain("vael"),
      moonTerrain: g.terrain("tethys"),
      workers: g.workers(),
      hud: document.getElementById("hud")?.textContent ?? "",
      cameraAtOrigin: g.camera.position.length(),
    };
  });
  expect(snap.bodies).toEqual(["vesper", "vael", "tethys", "cinder"]);
  expect(snap.mode).toBe("onFoot");
  expect(snap.shipBody).toBe("vael");
  expect(snap.playerBody).toBe("vael");
  expect(snap.shipLanded).toBe(true);
  expect(snap.shipToPad).toBeLessThan(3); // on the survey pad
  expect(Math.abs(snap.playerAlt)).toBeLessThan(0.1); // standing on the ground
  expect(snap.terrain.built).toBeGreaterThanOrEqual(6); // face roots at least
  expect(snap.moonTerrain.built).toBeGreaterThanOrEqual(6);
  expect(snap.hud).toContain("ON FOOT");
  expect(snap.cameraAtOrigin).toBe(0); // floating origin: the camera is the origin
  expectNoErrors(shared.errors());
});

test("renders frames and the parked skiff stays put on its pad", async () => {
  const page = shared.page();
  const before = await page.evaluate(() => {
    const g = (window as any).__game;
    return { frames: g.scene.getFrameId(), pos: g.sim.ship.pos.asArray() };
  });
  // Software GL is slow (shader compiles on first frames): wait for progress.
  await page.waitForFunction((f0) => (window as any).__game.scene.getFrameId() > f0 + 2, before.frames, {
    timeout: 90000,
  });
  const after = await page.evaluate(() => {
    const g = (window as any).__game;
    g.step(20); // 20 simulated seconds, hands off
    return { frames: g.scene.getFrameId(), pos: g.sim.ship.pos.asArray(), landed: g.sim.ship.landed };
  });
  expect(after.frames).toBeGreaterThan(before.frames);
  const moved = Math.hypot(...after.pos.map((v: number, i: number) => v - before.pos[i]));
  expect(moved).toBeLessThan(0.05);
  expect(after.landed).toBe(true);
  expectNoErrors(shared.errors());
});
