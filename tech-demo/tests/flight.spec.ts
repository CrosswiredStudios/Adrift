import { test, expect } from "@playwright/test";
import { expectNoErrors, sharedGame } from "./helpers";

const shared = sharedGame();

test("takeoff with assist: climbs, then hovers when released", async () => {
  const page = shared.page();
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    g.freeze();
    g.reset();
    g.setMode("ship");
    g.input.setAxis("thrustY", 1);
    g.step(2.5);
    g.input.setAxis("thrustY", undefined);
    g.step(3); // damping takes the climb out
    const alt0 = g.sim.ship.altitude;
    g.step(5);
    return { alt0, alt1: g.sim.ship.altitude, speed: g.sim.ship.vel.length(), landed: g.sim.ship.landed };
  });
  expect(res.alt0).toBeGreaterThan(15);
  expect(Math.abs(res.alt1 - res.alt0)).toBeLessThan(2);
  expect(res.speed).toBeLessThan(1);
  expect(res.landed).toBe(false);
  expectNoErrors(shared.errors());
});

test("assist off is pure Newtonian: the ship falls", async () => {
  const page = shared.page();
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    g.placeShip("vael", 26.5, 96, 300, 0);
    g.setMode("ship");
    g.sim.ship.assist = false;
    g.step(2);
    return { vs: g.sim.ship.verticalSpeed };
  });
  expect(res.vs).toBeLessThan(-12);
  expectNoErrors(shared.errors());
});

test("lands gently on terrain with the down thrusters", async () => {
  const page = shared.page();
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    g.placeShip("vael", 26.4, 96.2, 40, 0);
    g.setMode("ship");
    g.sim.ship.assist = true;
    g.input.setAxis("thrustY", -0.4);
    for (let i = 0; i < 60 * 25 && !g.sim.ship.landed; i++) g.step(1 / 60);
    g.input.setAxis("thrustY", undefined);
    g.step(3);
    return { landed: g.sim.ship.landed, hull: g.sim.ship.hull, alt: g.sim.ship.altitude };
  });
  expect(res.landed).toBe(true);
  expect(res.hull).toBe(1);
  expect(res.alt).toBeLessThan(2.5);
  expectNoErrors(shared.errors());
});

test("coasts on a stable orbit around Vael (rotating-frame physics)", async () => {
  const page = shared.page();
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    const sim = g.sim;
    const vael = sim.system.get("vael");
    g.placeShip("vael", 0, 0, 1800, 90);
    g.setMode("ship");
    const r = sim.ship.pos.length();
    // Circular inertial speed eastward, expressed in the rotating body frame:
    // v_B = v_I - w x r (w along the body's +Y).
    const up = sim.ship.pos.clone().normalize();
    const V = up.constructor;
    const east = V.Cross(new V(0, 1, 0), up).normalize();
    const vI = east.scale(Math.sqrt(vael.mu / r));
    const wxr = V.Cross(new V(0, vael.spinRate, 0), sim.ship.pos);
    sim.ship.vel.copyFrom(vI.subtract(wxr));
    let minR = Infinity;
    let maxR = 0;
    const period = 2 * Math.PI * Math.sqrt(r ** 3 / vael.mu);
    for (let t = 0; t < period; t += 1) {
      g.step(1);
      const d = sim.ship.pos.length();
      minR = Math.min(minR, d);
      maxR = Math.max(maxR, d);
    }
    return { r, minR, maxR, period, body: sim.shipBody.id };
  });
  expect(res.body).toBe("vael");
  expect((res.maxR - res.minR) / res.r).toBeLessThan(0.03);
  expectNoErrors(shared.errors());
});

test("SOI transfer preserves inertial position and velocity", async () => {
  const page = shared.page();
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    const sim = g.sim;
    const tethys = sim.system.get("tethys");
    // Start in Vael's frame just outside Tethys' SOI, moving straight at the moon.
    const moonCenterI = tethys.positionAt(sim.time);
    const V = moonCenterI.constructor;
    // Build an inertial point 1.1 SOI from the moon on the Vael side.
    const vael = sim.system.get("vael");
    const toVael = vael.positionAt(sim.time).subtract(moonCenterI).normalize();
    const pI = moonCenterI.add(toVael.scale(tethys.soi * 1.05));
    const vI = toVael.scale(-120).add(tethys.velocityAt(sim.time));
    // Express in Vael's frame.
    const f = vael;
    sim.shipBody = f;
    const frames = {
      rot: f.rotationAt(sim.time),
      pos: f.positionAt(sim.time),
      vel: f.velocityAt(sim.time),
      w: f.angularVelocityInertial(),
    };
    const inv = frames.rot.constructor.Inverse(frames.rot);
    const rel = pI.subtract(frames.pos);
    sim.ship.pos.copyFrom(rel.applyRotationQuaternion(inv));
    const vRel = vI.subtract(frames.vel).subtract(V.Cross(frames.w, rel));
    sim.ship.vel.copyFrom(vRel.applyRotationQuaternion(inv));
    sim.ship.assist = false;
    g.setMode("ship");
    let switched = -1;
    let before = null;
    for (let i = 0; i < 60 * 20; i++) {
      const s = g.shipInertial();
      g.step(1 / 60);
      if (sim.shipBody.id === "tethys") {
        switched = i;
        before = s;
        break;
      }
    }
    const after = g.shipInertial();
    return { switched, before, after };
  });
  expect(res.switched).toBeGreaterThan(0);
  // One step apart: positions differ by v*dt (~2 m), velocities barely change.
  const dp = Math.hypot(...res.after.pos.map((v: number, i: number) => v - res.before.pos[i]));
  const dv = Math.hypot(...res.after.vel.map((v: number, i: number) => v - res.before.vel[i]));
  expect(dp).toBeLessThan(5);
  expect(dv).toBeLessThan(1);
  expectNoErrors(shared.errors());
});
