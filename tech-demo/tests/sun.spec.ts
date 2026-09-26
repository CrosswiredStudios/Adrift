import { test, expect, Page } from "@playwright/test";

/**
 * Sun (Sol) tests: the star is a real body - aligned with the scene light,
 * ~7.6 degrees wide, solid/landable, HUD-visible, never occluded by the
 * starfield dome - and the old sky sprite stays deleted.
 *
 * Software GL renders at a few fps: drive the ship through `__game.step` and
 * allow >= 6 s per screenshot state (see repo memory).
 */

const stepFrames = async (page: Page, frames: number, dt: number): Promise<void> => {
  await page.evaluate(
    ([n, h]) => {
      const g = (window as unknown as { __game: any }).__game;
      for (let i = 0; i < (n as number); i++) g.step(h as number);
    },
    [frames, dt]
  );
};

const boot = async (page: Page): Promise<void> => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => (window as unknown as { __game?: unknown }).__game !== undefined,
    null,
    { timeout: 30000 }
  );
  await page.waitForTimeout(3000); // let the first frames settle (textures load async)
};

/** Hide Vael's cloud deck so it never sits between the camera and the sun. */
const clearSkies = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    g.scene.getMeshByName("Vael Prime-clouds")?.setEnabled(false);
  });
};

/**
 * Deep-space state: on the star's own axis over Vael's day cap, nose 18 deg off
 * the sun (the chase camera then sees the sun ~23 deg above its forward axis and
 * the hull never silhouettes it). The look up-vector is built perpendicular to
 * the aim - passing the radial there would be near-antiparallel to the aim
 * direction and produce a degenerate orientation.
 */
const placeInDeepSpace = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    const V = g.bodies[0].center.constructor as any;
    const u = g.scene.getLightByName("sun").direction.scale(-1).normalize();
    const ref = Math.abs(u.y) < 0.9 ? new V(0, 1, 0) : new V(1, 0, 0);
    const side = V.Cross(u, ref).normalize();
    const off = (18 * Math.PI) / 180;
    const aim = u.scale(Math.cos(off)).addInPlace(side.scale(Math.sin(off))).normalize();
    const upAxis = V.Cross(side, aim).normalize();
    g.ship.position.copyFrom(g.bodies[0].center).addInPlace(u.scale(600 + 520 + 400));
    g.state.landed = false;
    g.state.floating = false;
    g.state.cruise = 0;
    g.state.velocity.scaleInPlace(0);
    // NB: FromLookDirectionLH aims the local -Z at the target, so negate.
    const Q = g.ship.rotationQuaternion.constructor as any;
    g.ship.rotationQuaternion.copyFrom(Q.FromLookDirectionLH(aim.scale(-1), upAxis));
  });
};

/**
 * Low-altitude state: hover `altAbove` above Vael's mean radius where the sun
 * sits ~8 deg above the horizon, nose aimed along the sun's azimuth at
 * elevation 0 (so the flight model's horizon-hold keeps the attitude). The
 * chase camera looks ~15 deg down at the ship, so the sun ends up ~22 deg above
 * its forward axis - inside the 30 deg half-FOV.
 */
const placeLow = async (page: Page, altAbove: number): Promise<{ sunElevDeg: number }> =>
  page.evaluate((alt) => {
    const g = (window as unknown as { __game: any }).__game;
    const V = g.bodies[0].center.constructor as any;
    const u = g.scene.getLightByName("sun").direction.scale(-1).normalize();
    const ref = Math.abs(u.y) < 0.9 ? new V(0, 1, 0) : new V(1, 0, 0);
    const side = V.Cross(u, ref).normalize();
    const elev = (8 * Math.PI) / 180;
    const upDir = u.scale(Math.sin(elev)).addInPlace(side.scale(Math.cos(elev))).normalize();
    g.ship.position.copyFrom(g.bodies[0].center).addInPlace(upDir.scale(600 + (alt as number)));
    g.state.landed = false;
    g.state.floating = false;
    g.state.cruise = 0;
    g.state.velocity.scaleInPlace(0);
    const toward = g.sun.body.center.subtract(g.ship.position).normalize();
    const aim = toward.subtract(upDir.scale(toward.dot(upDir))).normalize(); // horizon tangent
    const Q = g.ship.rotationQuaternion.constructor as any;
    g.ship.rotationQuaternion.copyFrom(Q.FromLookDirectionLH(aim.scale(-1), upDir));
    return { sunElevDeg: (Math.asin(toward.dot(upDir)) * 180) / Math.PI };
  }, altAbove);

/** Camera-forward alignment with the sun + a couple of state readouts. */
const viewState = async (page: Page): Promise<{ dot: number; inFrustum: boolean; atmo: number; sky: number }> =>
  page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    const toSun = g.sun.body.center.subtract(g.camera.position).normalize();
    const fwd = g.camera.getForwardRay().direction.normalize();
    return {
      dot: fwd.dot(toSun),
      inFrustum: g.camera.isInFrustum(g.sun.core),
      atmo: g.state.atmoDensity,
      sky: (g.bodies[0] as any).atmosphere?.skyFactor ?? -1,
    };
  });

test("Sol wiring: real aligned body, starfield clearance, sprite gone", async ({ page }) => {
  test.setTimeout(120000);
  await boot(page);

  const data = await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    const sol = g.sun;
    const light = g.scene.getLightByName("sun");
    const toward = light.direction.scale(-1);
    const center = sol.body.center;
    const dist = center.length();
    const dirFromOrigin = center.scale(1 / dist);
    const core = g.scene.getMeshByName("Sol-core");
    const corona = g.scene.getMeshByName("Sol-corona");
    return {
      bodyCount: g.bodies.length,
      lastIndex: g.bodies.indexOf(sol.body),
      lastName: g.bodies[g.bodies.length - 1].name,
      radius: sol.body.radius,
      dist,
      alignDot: dirFromOrigin.dot(toward),
      angularDeg: ((2 * Math.atan(sol.body.radius / dist)) * 180) / Math.PI,
      coreEnabled: !!core?.isEnabled(),
      coronaEnabled: !!corona?.isEnabled(),
      coreMat: core?.material?.getClassName?.(),
      corePickable: core?.isPickable,
      // A SpriteManager would register itself here (the old "sun-mgr" sprite);
      // no sprites at all = the space sun is only the real body.
      spriteManagers: (g.scene.spriteManagers ?? []).length,
      camToSun: g.camera.position.subtract(center).length(),
    };
  });
  console.log("sol wiring", JSON.stringify(data));

  // Appended to the body list (index 2) so existing tests keep bodies[0]/[1].
  expect(data.bodyCount).toBe(3);
  expect(data.lastIndex).toBe(2);
  expect(data.lastName).toBe("Sol");
  expect(data.radius).toBe(2400);
  // Sits exactly on the scene light axis: terminator, glare and disc all agree.
  expect(data.alignDot).toBeGreaterThan(0.9995);
  expect(data.dist).toBeGreaterThan(30000);
  // Giant star: ~7.6 degrees wide (a real sun is 0.53).
  expect(data.angularDeg).toBeGreaterThan(6);
  expect(data.angularDeg).toBeLessThan(9);
  // Real meshes, not pickable; and the old sun sprite must stay deleted.
  expect(data.coreEnabled).toBe(true);
  expect(data.coronaEnabled).toBe(true);
  expect(data.coreMat).toBe("ShaderMaterial");
  expect(data.corePickable).toBe(false);
  expect(data.spriteManagers).toBe(0);
  // The opaque starfield dome (55k radius) must never cut the star off.
  expect(data.camToSun).toBeLessThan(55000);

  // Nav key 3 selects the star as the HUD target.
  await page.keyboard.press("3");
  const target = await page.evaluate(
    () => (window as unknown as { __game: any }).__game.state.target?.name ?? null
  );
  expect(target).toBe("Sol");
});

test("giant sun from deep space", async ({ page }) => {
  test.setTimeout(180000);
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });

  await boot(page);
  await clearSkies(page);
  await placeInDeepSpace(page);
  await stepFrames(page, 240, 1 / 60);
  await page.waitForTimeout(7000);

  const view = await viewState(page);
  console.log("space view", JSON.stringify(view));
  // The camera points near the star (offset aim + down-tilt ~23 deg) and the
  // star is inside the frustum, far above any air.
  expect(view.dot).toBeGreaterThan(0.85);
  expect(view.inFrustum).toBe(true);
  expect(view.atmo).toBeLessThan(0.05);
  await page.screenshot({ path: "test-results/sun-space.png" });
  expect(problems).toEqual([]);
});

test("sun from the ground and mid-atmosphere: glare aligns, no double sun", async ({ page }) => {
  test.setTimeout(180000);

  await boot(page);
  await clearSkies(page);

  // Ground view: deep in the air, dome at full glare, sun low over the terrain.
  const ground = await placeLow(page, 45);
  expect(ground.sunElevDeg).toBeGreaterThan(5);
  expect(ground.sunElevDeg).toBeLessThan(12);
  await stepFrames(page, 120, 1 / 60);
  await page.waitForTimeout(7000);
  const groundView = await viewState(page);
  console.log("ground view", JSON.stringify({ ...groundView, sunElevDeg: ground.sunElevDeg }));
  expect(groundView.dot).toBeGreaterThan(0.85);
  expect(groundView.atmo).toBeGreaterThan(0.8); // deep in the air, dome at full glare
  await page.screenshot({ path: "test-results/sun-ground.png" });

  // Mid-atmosphere: the dome is cross-fading onto the real body - the shot that
  // would show any double-sun misalignment between disc/halo and body.
  await placeLow(page, 470);
  await stepFrames(page, 120, 1 / 60);
  await page.waitForTimeout(7000);
  const midView = await viewState(page);
  console.log("mid view", JSON.stringify(midView));
  expect(midView.sky).toBeGreaterThan(0.1);
  expect(midView.sky).toBeLessThan(0.9); // genuinely mid-handoff
  expect(midView.dot).toBeGreaterThan(0.8);
  await page.screenshot({ path: "test-results/sun-midatmo.png" });
});
