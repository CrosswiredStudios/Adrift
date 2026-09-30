import { test, expect } from "@playwright/test";
import { expectNoErrors, sharedGame } from "./helpers";

const shared = sharedGame();

test("the planet spins: a parked ship rides along, fixed in the body frame", async () => {
  const page = shared.page();
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    g.freeze();
    g.reset();
    const b0 = g.sim.ship.pos.clone();
    const i0 = g.shipInertial().pos;
    const v0 = g.bodyPosition("vael");
    g.step(60);
    const i1 = g.shipInertial().pos;
    const v1 = g.bodyPosition("vael");
    const rel0 = i0.map((v: number, k: number) => v - v0[k]);
    const rel1 = i1.map((v: number, k: number) => v - v1[k]);
    return {
      bodyFrameDrift: g.sim.ship.pos.subtract(b0).length(),
      relMoved: Math.hypot(...rel1.map((v: number, k: number) => v - rel0[k])),
      radius: Math.hypot(...rel0),
      spinRate: g.sim.system.get("vael").spinRate,
      landed: g.sim.ship.landed,
    };
  });
  expect(res.bodyFrameDrift).toBeLessThan(0.05);
  expect(res.landed).toBe(true);
  // Around the spin axis the pad travels r*w*t (times cos(latitude) and tilt terms).
  expect(res.relMoved).toBeGreaterThan(res.radius * res.spinRate * 60 * 0.5);
  expect(res.relMoved).toBeLessThan(res.radius * res.spinRate * 60 * 1.05);
  expectNoErrors(shared.errors());
});

test("day turns to night: local solar time advances ~1.2 h per minute", async () => {
  const page = shared.page();
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    g.render();
    const h0 = g.localHour();
    g.step(60);
    g.render();
    const h1 = g.localHour();
    g.step(600); // half a day later
    g.render();
    const h2 = g.localHour();
    return { h0, h1, h2 };
  });
  expect(res.h0).toBeGreaterThan(6); // the game starts in the morning
  expect(res.h0).toBeLessThan(11);
  const dh = (res.h1 - res.h0 + 24) % 24;
  expect(dh).toBeGreaterThan(0.9);
  expect(dh).toBeLessThan(1.5);
  const half = (res.h2 - res.h1 + 24) % 24;
  expect(Math.abs(half - 12)).toBeLessThan(1);
  expectNoErrors(shared.errors());
});

test("Tethys orbits Vael on rails and stays tidally locked", async () => {
  const page = shared.page();
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    const sim = g.sim;
    const t = sim.time;
    const m = sim.system.get("tethys");
    const v = sim.system.get("vael");
    const rel = (tt: number) => m.positionAt(tt).subtract(v.positionAt(tt));
    const a = rel(t);
    const b = rel(t + m.orbitPeriod / 4);
    const face = (tt: number) => {
      const x = new a.constructor(1, 0, 0).applyRotationQuaternion(m.rotationAt(tt));
      return x.dot(rel(tt).normalize().scale(-1));
    };
    return {
      r: a.length(),
      quarterAngle: Math.acos(a.normalize().dot(b.normalize())),
      period: m.orbitPeriod,
      faceNow: face(t),
      faceLater: face(t + 333),
    };
  });
  expect(res.r).toBeCloseTo(12000, 3);
  expect(res.quarterAngle).toBeCloseTo(Math.PI / 2, 3);
  expect(res.period).toBeGreaterThan(1200); // Kepler around Vael: ~22 min
  expect(res.faceNow).toBeCloseTo(1, 6);
  expect(res.faceLater).toBeCloseTo(1, 6);
  expectNoErrors(shared.errors());
});

test("floating origin: the camera stays at the origin and far bodies keep precision", async () => {
  const page = shared.page();
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    g.placeShip("vael", 10, 40, 5000, 0);
    g.setMode("ship");
    g.step(1 / 60);
    g.render();
    const star = g.views.get("vesper").root.position.length();
    return { cam: g.camera.position.length(), shipRender: g.game.shipRoot.position.length(), star };
  });
  expect(res.cam).toBe(0);
  expect(res.shipRender).toBeLessThan(40); // the chase camera sits right behind the ship
  expect(res.star).toBeGreaterThan(250000);
  expectNoErrors(shared.errors());
});
