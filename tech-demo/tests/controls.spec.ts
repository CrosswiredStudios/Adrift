import { test, expect } from "@playwright/test";
import { boot, collectErrors, expectNoErrors } from "./helpers";

// Deterministic flight-control tests. Like the smoke tests, these drive the
// simulation through window.__game.step(seconds) and synthesize input through
// the action layer (g.input.setAxis / setButton): software-GL rendering is far
// too slow here for realtime keyboard flight, and step() is reproducible.

test("idle: ship rests on the pad without jitter or drift", async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  const samples = await page.evaluate(() => {
    const g = (window as any).__game;
    const out: { p: number[]; q: number[]; alt: number; speed: number; landed: boolean }[] = [];
    for (let i = 0; i < 720; i++) {
      // 12 simulated seconds, hands off
      g.step(1 / 60);
      if (i % 30 === 29) {
        out.push({
          p: g.ship.position.asArray(),
          q: g.ship.rotationQuaternion.asArray(),
          alt: g.state.altitude,
          speed: g.state.velocity.length(),
          landed: g.state.landed,
        });
      }
    }
    return out;
  });
  const range = (vals: number[]): number => Math.max(...vals) - Math.min(...vals);
  const tail = samples.slice(8); // skip the first ~4 simulated seconds
  for (const axis of [0, 1, 2]) {
    expect(range(tail.map((s) => s.p[axis]))).toBeLessThan(0.05); // no visible jitter
  }
  for (const comp of [0, 1, 2, 3]) {
    expect(range(tail.map((s) => s.q[comp]))).toBeLessThan(0.002); // attitude rock steady
  }
  expect(range(tail.map((s) => s.alt))).toBeLessThan(0.2);
  expect(Math.max(...tail.map((s) => s.speed))).toBeLessThan(0.5);
  expect(tail.every((s) => s.landed)).toBe(true);
  expectNoErrors(errors);
});

test("takeoff: pitch up + throttle lifts off the pad", async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    g.input.setAxis("pitch", 1);
    g.input.setAxis("thrustZ", 1);
    for (let i = 0; i < 36; i++) g.step(1 / 60); // pitch up ~0.6 s while thrust builds
    g.input.setAxis("pitch", undefined);
    for (let i = 0; i < 174; i++) g.step(1 / 60); // keep climbing to ~3.5 s total
    g.input.setAxis("thrustZ", undefined);
    return { alt: g.state.altitude, landed: g.state.landed, speed: g.state.velocity.length() };
  });
  expect(res.alt).toBeGreaterThan(10);
  expect(res.landed).toBe(false);
  expect(res.speed).toBeGreaterThan(20);
  expectNoErrors(errors);
});

test("flight is frame-rate independent", async ({ page }) => {
  const errors = collectErrors(page);
  const run = async (dt: number, frames: number) => {
    await boot(page);
    const res = await page.evaluate(
      ({ dt, frames }) => {
        const g = (window as any).__game;
        const V = g.state.velocity.constructor as new (x: number, y: number, z: number) => any;
        // Clean space start so ground contact cannot skew the comparison.
        const up = g.ship.position.subtract(g.bodies[0].center).normalize();
        g.ship.position.copyFrom(g.bodies[0].center).addInPlace(up.scale(600 + 150));
        g.state.velocity.set(0, 0, 0);
        g.state.cruise = 50;
        g.state.landed = false;
        g.input.setAxis("yaw", -1);
        g.input.setAxis("thrustZ", 1);
        for (let i = 0; i < frames; i++) g.step(dt);
        g.input.setAxis("yaw", undefined);
        g.input.setAxis("thrustZ", undefined);
        return {
          pos: g.ship.position.asArray() as number[],
          nose: new V(0, 0, 1).applyRotationQuaternion(g.ship.rotationQuaternion).asArray() as number[],
          speed: g.state.velocity.length() as number,
        };
      },
      { dt, frames },
    );
    await page.reload();
    return res;
  };
  const fine = await run(1 / 120, 360); // 3 simulated seconds
  const coarse = await run(1 / 30, 90); // 3 simulated seconds
  const dot = fine.nose[0] * coarse.nose[0] + fine.nose[1] * coarse.nose[1] + fine.nose[2] * coarse.nose[2];
  expect(Math.acos(Math.min(1, Math.max(-1, dot)))).toBeLessThan(0.06); // heading within ~3.5 deg
  expect(Math.abs(fine.speed - coarse.speed) / Math.max(1, coarse.speed)).toBeLessThan(0.05);
  const dist = Math.hypot(
    fine.pos[0] - coarse.pos[0],
    fine.pos[1] - coarse.pos[1],
    fine.pos[2] - coarse.pos[2],
  );
  expect(dist).toBeLessThan(15);
  expectNoErrors(errors);
});

test("steering: pitch, banked turns, no barrel rolls, auto-level", async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    const V = g.state.velocity.constructor as new (x: number, y: number, z: number) => any;
    const fwd = () => new V(0, 0, 1).applyRotationQuaternion(g.ship.rotationQuaternion);
    const up = () => new V(0, 1, 0).applyRotationQuaternion(g.ship.rotationQuaternion);
    const planetUp = () => g.ship.position.subtract(g.bodies[0].center).normalize();
    // Clean space start. Capture the radial direction BEFORE teleporting: after
    // copyFrom(center) the position is zero and normalize() would return zero.
    const spacerUp = planetUp();
    g.ship.position.copyFrom(g.bodies[0].center).addInPlace(spacerUp.scale(600 + 150));
    g.state.velocity.set(0, 0, 0);
    g.state.cruise = 50;
    g.state.landed = false;

    // Pitch: W raises the nose against the horizon.
    const dot0 = fwd().dot(planetUp());
    g.input.setAxis("pitch", 1);
    for (let i = 0; i < 30; i++) g.step(1 / 60); // 0.5 s
    g.input.setAxis("pitch", undefined);
    const dot1 = fwd().dot(planetUp());

    // Yaw: A turns left and banks, without barrel-rolling.
    const left0 = (V as unknown as { Cross: (a: unknown, b: unknown) => any }).Cross(up(), fwd()).negate(); // ship-left before the turn
    let maxBank = 0;
    g.input.setAxis("yaw", -1);
    for (let i = 0; i < 60; i++) {
      // 1 s of turning
      g.step(1 / 60);
      maxBank = Math.max(maxBank, Math.abs(g.bankDeg()));
    }
    g.input.setAxis("yaw", undefined);
    const leftness = fwd().dot(left0);
    const bankHeld = g.bankDeg();

    // Auto-level: hands off, wings return level.
    for (let i = 0; i < 240; i++) g.step(1 / 60); // 4 s
    const bankAfter = g.bankDeg();
    return { dot0, dot1, leftness, maxBank, bankHeld, bankAfter };
  });
  expect(res.dot1).toBeGreaterThan(res.dot0 + 0.3); // W pitched the nose up
  expect(res.leftness).toBeGreaterThan(0.2); // A turned the nose left
  expect(res.maxBank).toBeGreaterThan(15); // banked into the turn
  expect(res.maxBank).toBeLessThan(50); // ...but never barrel-rolled
  expect(res.bankHeld).toBeLessThan(0); // left turn = left bank (right wing up)
  expect(Math.abs(res.bankAfter)).toBeLessThan(5); // auto-level returns wings level
  expectNoErrors(errors);
});

test("manual roll with E and auto-level on release", async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    const planetUp = () => g.ship.position.subtract(g.bodies[0].center).normalize();
    // Capture the radial direction BEFORE teleporting (see steering test note).
    const spacerUp = planetUp();
    g.ship.position.copyFrom(g.bodies[0].center).addInPlace(spacerUp.scale(600 + 150));
    g.state.velocity.set(0, 0, 0);
    g.state.cruise = 50;
    g.state.landed = false;
    g.input.setAxis("roll", 1); // roll right
    for (let i = 0; i < 20; i++) g.step(1 / 60); // ~0.33 s
    g.input.setAxis("roll", undefined);
    const rolled = g.bankDeg();
    for (let i = 0; i < 240; i++) g.step(1 / 60); // 4 s hands off
    return { rolled, after: g.bankDeg() };
  });
  expect(res.rolled).toBeGreaterThan(20); // E rolled right (+ = right wing down)
  expect(Math.abs(res.after)).toBeLessThan(5); // wings level again
  expectNoErrors(errors);
});

test("mouse flight: pointer-lock motion pushes a self-centering stick", async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    // Mouse moved right (as pointer-lock movementX would report).
    g.input.addMouseDelta(120, 0);
    g.step(1 / 60);
    const yawRight = g.steer.yaw;
    // Mouse moved up = nose up.
    g.input.addMouseDelta(0, -80);
    g.step(1 / 60);
    const pitchUp = g.steer.pitch;
    // Hands off: the spring recentres the stick.
    for (let i = 0; i < 90; i++) g.step(1 / 60);
    return { yawRight, pitchUp, yawCentered: g.steer.yaw, pitchCentered: g.steer.pitch };
  });
  expect(res.yawRight).toBeLessThan(-0.2); // right = negative steer yaw (nose-left is +)
  expect(res.pitchUp).toBeGreaterThan(0.1);
  expect(Math.abs(res.yawCentered)).toBeLessThan(0.05);
  expect(Math.abs(res.pitchCentered)).toBeLessThan(0.05);
  expectNoErrors(errors);
});

test("unlocked mouse motion does not steer", async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  const vp = page.viewportSize();
  await page.mouse.move(vp!.width * 0.9, vp!.height * 0.5);
  await page.mouse.move(vp!.width * 0.1, vp!.height * 0.2);
  const yaw = await page.evaluate(() => {
    const g = (window as any).__game;
    g.step(0.5);
    return Math.abs(g.steer.yaw as number);
  });
  expect(yaw).toBeLessThan(1e-6);
  expectNoErrors(errors);
});

test("throttle, boost and brake drive the cruise speed", async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    g.input.setAxis("thrustZ", 1);
    for (let i = 0; i < 120; i++) g.step(1 / 60); // 2 s of throttle
    const cruised = g.state.cruise;
    g.input.setAxis("thrustY", -1); // brake while the throttle is still held
    for (let i = 0; i < 120; i++) g.step(1 / 60);
    const braked = g.state.cruise;
    g.input.setAxis("thrustY", undefined);
    g.input.setButton("boost", true); // throttle + boost
    for (let i = 0; i < 120; i++) g.step(1 / 60);
    const boosted = g.state.cruise;
    g.input.setButton("boost", undefined);
    g.input.setAxis("thrustZ", undefined);
    return { cruised, braked, boosted };
  });
  expect(res.cruised).toBeGreaterThan(100); // ~120 after 2 s at +60/s
  expect(res.braked).toBeLessThan(50); // brake worked even while thrusting
  expect(res.boosted).toBeGreaterThan(res.braked + 400); // boost ramps at 260/s
  expectNoErrors(errors);
});

test("window blur clears stuck keys", async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  await page.keyboard.down("w");
  const held = await page.evaluate(() => (window as any).__game.input.keys.has("KeyW") === true);
  expect(held).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const cleared = await page.evaluate(() => !(window as any).__game.input.keys.has("KeyW"));
  expect(cleared).toBe(true);
  await page.keyboard.up("w");
  expectNoErrors(errors);
});
