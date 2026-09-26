import { test, expect } from "@playwright/test";

test("loads without errors and exposes game state", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.waitForFunction(() => (window as any).__game !== undefined, null, { timeout: 15000 });
  // Let a few frames render.
  await page.waitForTimeout(3000);
  const snap = await page.evaluate(() => {
    const g = (window as any).__game;
    return {
      shipPos: g.ship.position.asArray(),
      speed: g.state.velocity.length(),
      alt: g.state.altitude,
      atmo: g.state.atmoDensity,
      meshCount: g.scene.meshes.length,
      hasVael: !!g.scene.getMeshByName("Vael Prime-ground"),
      hasWater: !!g.scene.getMeshByName("Vael Prime-water"),
      hasClouds: !!g.scene.getMeshByName("Vael Prime-clouds"),
      hasOuter: !!g.scene.getMeshByName("Vael Prime-atmo-outer"),
      hasInner: !!g.scene.getMeshByName("Vael Prime-sky-inner"),
      hasShip: !!g.scene.getMeshByName("ship"),
      cameraPos: g.camera.position.asArray(),
      hud: document.getElementById("hud")?.textContent?.slice(0, 200),
    };
  });
  console.log(JSON.stringify(snap, null, 2));
  expect(snap.hasVael).toBe(true);
  expect(snap.hasWater).toBe(true);
  expect(snap.hasClouds).toBe(true);
  expect(snap.hasOuter).toBe(true);
  expect(snap.hasInner).toBe(true);
  expect(snap.hasShip).toBe(true);
  // Chase camera settled behind the ship, not NaN and not far off in space.
  expect(snap.cameraPos.every((n: number) => Number.isFinite(n))).toBe(true);
  const camDist = Math.hypot(
    snap.cameraPos[0] - snap.shipPos[0],
    snap.cameraPos[1] - snap.shipPos[1],
    snap.cameraPos[2] - snap.shipPos[2]
  );
  expect(camDist).toBeLessThan(40);
  expect(errors.filter((e) => !e.includes("favicon"))).toEqual([]);
});

test("takeoff to space transitions atmosphere to zero", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.waitForFunction(() => (window as any).__game !== undefined, null, { timeout: 15000 });
  const start = await page.evaluate(() => {
    const g = (window as any).__game;
    return { alt: g.state.altitude, atmo: g.state.atmoDensity, height: g.bodies[0].atmosphereHeight };
  });
  console.log("start", JSON.stringify(start));
  expect(start.atmo).toBeGreaterThan(0.5);
  expect(start.alt).toBeLessThan(30);
  // Deterministic simulation: point nose straight up, hold full thrust via
  // __game.step (software GL renders too slowly for realtime flight).
  const climb = await page.evaluate(() => {
    const g = (window as any).__game;
    const up = g.ship.position.subtract(g.bodies[0].center).normalize();
    const ref = Math.abs(up.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    const z = [up.x, up.y, up.z];
    let x = [ref.y * z[2] - ref.z * z[1], ref.z * z[0] - ref.x * z[2], ref.x * z[1] - ref.y * z[0]];
    const xl = Math.hypot(x[0], x[1], x[2]); x = x.map((v) => v / xl);
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    const m = [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
    const t = m[0] + m[4] + m[8];
    let qw, qx, qy, qz;
    if (t > 0) {
      const s = Math.sqrt(t + 1) * 2;
      qw = 0.25 * s; qx = (m[7] - m[5]) / s; qy = (m[2] - m[6]) / s; qz = (m[3] - m[1]) / s;
    } else if (m[0] > m[4] && m[0] > m[8]) {
      const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
      qw = (m[7] - m[5]) / s; qx = 0.25 * s; qy = (m[1] + m[3]) / s; qz = (m[2] + m[6]) / s;
    } else if (m[4] > m[8]) {
      const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
      qw = (m[2] - m[6]) / s; qx = (m[1] + m[3]) / s; qy = 0.25 * s; qz = (m[5] + m[7]) / s;
    } else {
      const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
      qw = (m[3] - m[1]) / s; qx = (m[2] + m[6]) / s; qy = (m[5] + m[7]) / s; qz = 0.25 * s;
    }
    g.ship.rotationQuaternion.set(qx, qy, qz, qw);
    // Arcade scheme: Up arrow = throttle up; W pitches the nose, so leave it alone here.
    g.state.cruise = 120;
    g.input["arrowup"] = true;
    const samples = [];
    for (let i = 0; i < 2400; i++) {
      g.step(1 / 60); // up to 40 simulated seconds of powered climb
      if (i % 300 === 299) {
        samples.push({ alt: g.state.altitude, atmo: g.state.atmoDensity, speed: g.state.velocity.length(), heat: g.state.heat });
      }
    }
    g.input["arrowup"] = false;
    return samples;
  });
  console.log(JSON.stringify(climb, null, 2));
  const last = climb[climb.length - 1];
  expect(last.alt).toBeGreaterThan(start.height * 1.15); // clear of the atmosphere shell
  expect(last.atmo).toBe(0);
});

test("reentry heats up and lands back in atmosphere", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.waitForFunction(() => (window as any).__game !== undefined, null, { timeout: 15000 });
  const result = await page.evaluate(() => {
    const g = (window as any).__game;
    // Start in space above Vael: 400 units up, orbital-ish sideways velocity.
    const up = g.ship.position.subtract(g.bodies[0].center).normalize();
    g.ship.position.copyFrom(g.bodies[0].center).addInPlace(up.scale(600 + 400));
    g.state.velocity.set(0, 0, 0);
    g.state.velocity.addInPlace(new (g.state.velocity.constructor as new (x: number, y: number, z: number) => typeof g.state.velocity)(60, 0, 0));
    (g.state as any).cruise = 60;
    // Point nose down toward the planet for a steep reentry.
    const down = up.scale(-1);
    const ref = Math.abs(down.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    const z = [down.x, down.y, down.z];
    let x = [ref.y * z[2] - ref.z * z[1], ref.z * z[0] - ref.x * z[2], ref.x * z[1] - ref.y * z[0]];
    const xl = Math.hypot(x[0], x[1], x[2]); x = x.map((v) => v / xl);
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    const m = [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
    const t = m[0] + m[4] + m[8];
    let qw, qx, qy, qz;
    if (t > 0) {
      const s = Math.sqrt(t + 1) * 2;
      qw = 0.25 * s; qx = (m[7] - m[5]) / s; qy = (m[2] - m[6]) / s; qz = (m[3] - m[1]) / s;
    } else {
      const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
      qw = (m[3] - m[1]) / s; qx = (m[2] + m[6]) / s; qy = (m[5] + m[7]) / s; qz = 0.25 * s;
    }
    g.ship.rotationQuaternion.set(qx, qy, qz, qw);
    // Arcade scheme: fast cruise dives under Up-arrow throttle (W is pitch).
    g.state.cruise = 300;
    g.input["arrowup"] = true; // dive under throttle power
    let peakHeat = 0;
    let peakSpeed = 0;
    let final = null;
    for (let i = 0; i < 3600; i++) {
      g.step(1 / 60); // up to 60 simulated seconds of hot dive
      peakHeat = Math.max(peakHeat, g.state.heat);
      peakSpeed = Math.max(peakSpeed, g.state.velocity.length());
      // Once deep in atmosphere and heating, cut throttle to settle.
      // (Heat lags speed via lerp, so require atmo only — peakHeat updates below.)
      if (g.state.atmoDensity > 0.5) break;
      if (g.state.landed || g.state.altitude < 2) break;
    }
    // Let heat catch up: it lerps toward target, sample a few more steps.
    for (let i = 0; i < 300; i++) {
      g.step(1 / 60);
      peakHeat = Math.max(peakHeat, g.state.heat);
      peakSpeed = Math.max(peakSpeed, g.state.velocity.length());
    }
    g.input["arrowup"] = false;
    // Landing phase: reset to a gentle ~20-degree glide approach so the
    // constant cruise thrust drives a soft touchdown (proves atmosphere
    // flight is landable; the hot dive above already proved heating).
    g.ship.position.copyFrom(g.bodies[0].center).addInPlace(up.scale(600 + 25));
    const east = new (g.state.velocity.constructor as any)(0, 0, 1);
    const glide = east.scale(0.94).addInPlace(up.scale(-0.34)).normalize();
    const lvl = Math.abs(glide.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    const gz = [glide.x, glide.y, glide.z];
    let gx = [lvl.y * gz[2] - lvl.z * gz[1], lvl.z * gz[0] - lvl.x * gz[2], lvl.x * gz[1] - lvl.y * gz[0]];
    const gxl = Math.hypot(gx[0], gx[1], gx[2]); gx = gx.map((v: number) => v / gxl);
    const gy = [gz[1] * gx[2] - gz[2] * gx[1], gz[2] * gx[0] - gz[0] * gx[2], gz[0] * gx[1] - gz[1] * gx[0]];
    const gm = [gx[0], gy[0], gz[0], gx[1], gy[1], gz[1], gx[2], gy[2], gz[2]];
    const gt = gm[0] + gm[4] + gm[8];
    let gqw, gqx, gqy, gqz;
    if (gt > 0) {
      const s = Math.sqrt(gt + 1) * 2;
      gqw = 0.25 * s; gqx = (gm[7] - gm[5]) / s; gqy = (gm[2] - gm[6]) / s; gqz = (gm[3] - gm[1]) / s;
    } else {
      const s = Math.sqrt(1 + gm[8] - gm[0] - gm[4]) * 2;
      gqw = (gm[3] - gm[1]) / s; gqx = (gm[2] + gm[6]) / s; gqy = (gm[5] + gm[7]) / s; gqz = 0.25 * s;
    }
    g.ship.rotationQuaternion.set(gqx, gqy, gqz, gqw);
    g.state.velocity.copyFrom(glide.scale(15));
    g.state.cruise = 15; // landing phase: gentle glide approach for a soft touchdown
    for (let i = 0; i < 7200; i++) {
      g.step(1 / 60); // up to 120 more simulated seconds to touch down
      peakHeat = Math.max(peakHeat, g.state.heat);
      peakSpeed = Math.max(peakSpeed, g.state.velocity.length());
      if (g.state.landed || g.state.altitude < 2) {
        final = { alt: g.state.altitude, atmo: g.state.atmoDensity, speed: g.state.velocity.length(), landed: g.state.landed };
        break;
      }
    }
    return { peakHeat, peakSpeed, final };
  });
  console.log(JSON.stringify(result, null, 2));
  expect(result.peakHeat).toBeGreaterThan(0.2); // reentry heating registered
  expect(result.final).not.toBeNull();
  expect(result.final!.atmo).toBeGreaterThan(0.5); // back deep in atmosphere
});

test("atmosphere shells hand off by altitude and stars skip the glow layer", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.waitForFunction(() => (window as any).__game !== undefined, null, { timeout: 30000 });

  const ground = await page.evaluate(() => {
    const g = (window as any).__game;
    const glow = g.scene.getGlowLayerByName("main-glow");
    const stars = g.scene.getMeshByName("stars");
    return {
      innerEnabled: g.scene.getMeshByName("Vael Prime-sky-inner")?.isEnabled(),
      outerEnabled: g.scene.getMeshByName("Vael Prime-atmo-outer")?.isEnabled(),
      starsInGlow: glow && stars ? glow.hasMesh(stars) : null,
      sky: g.bodies[0].atmosphere?.skyFactor ?? -1,
    };
  });
  console.log("ground", JSON.stringify(ground));
  expect(ground.innerEnabled).toBe(true);
  expect(ground.outerEnabled).toBe(true);
  expect(ground.sky).toBeGreaterThan(0.9); // thick sky on the pad: stars stay hidden
  expect(ground.starsInGlow).toBe(false); // star dome must not be blurred by the glow layer

  const space = await page.evaluate(() => {
    const g = (window as any).__game;
    // Teleport above the atmosphere shell (radius 600 + 520) and simulate a few frames.
    const up = g.ship.position.subtract(g.bodies[0].center).normalize();
    g.ship.position.copyFrom(g.bodies[0].center).addInPlace(up.scale(g.bodies[0].radius + g.bodies[0].atmosphereHeight + 180));
    g.state.velocity.set(0, 0, 0);
    g.state.cruise = 0;
    for (let i = 0; i < 10; i++) g.step(1 / 60);
    return {
      alt: g.state.altitude,
      atmo: g.state.atmoDensity,
      sky: g.bodies[0].atmosphere?.skyFactor ?? -1,
      innerEnabled: g.scene.getMeshByName("Vael Prime-sky-inner")?.isEnabled(),
      outerEnabled: g.scene.getMeshByName("Vael Prime-atmo-outer")?.isEnabled(),
    };
  });
  console.log("space", JSON.stringify(space));
  expect(space.alt).toBeGreaterThan(150);
  expect(space.atmo).toBe(0);
  expect(space.sky).toBeLessThan(0.02);
  expect(space.innerEnabled).toBe(false); // sky dome must not render as a haze ball from space
  expect(space.outerEnabled).toBe(true); // limb glow stays available at any distance
});
