/**
 * Shared Playwright fixtures for the tech-demo suite. Single home for the
 * boot/step/place/orbit helpers copied across specs, plus the page-error
 * guard that controls.spec.ts was missing.
 */
import { Page } from "@playwright/test";

export type Dir = number[];

/** Load the app and wait for the deterministic debug handle. */
export async function boot(page: Page, waitForVegetation = false): Promise<void> {
  await page.goto("/", { waitUntil: "networkidle" });
  // Software GL on CI/headless boxes compiles shaders slowly: allow 90 s.
  await page.waitForFunction(() => (window as unknown as { __game?: unknown }).__game !== undefined, null, {
    timeout: 90000,
  });
  if (waitForVegetation) {
    await page.waitForFunction(
      () => {
        const v = (window as unknown as { __game: any }).__game.vegetation();
        return v.vael?.ready === true;
      },
      null,
      { timeout: 60000 },
    );
  }
}

/** Advance the simulation without rendering (headless software GL is ~1-4fps). */
export async function stepFrames(page: Page, frames: number, dt: number): Promise<void> {
  await page.evaluate(
    ([n, h]) => {
      const g = (window as unknown as { __game: any }).__game;
      for (let i = 0; i < (n as number); i++) g.step(h as number);
    },
    [frames, dt],
  );
}

/** Place the ship (camera follows) at `dir`, `above` sea-radius units up, aimed along `aim`. */
export async function placeAt(
  page: Page,
  bodyIndex: number,
  dir: Dir,
  aim: Dir,
  above: number,
): Promise<void> {
  await page.evaluate(
    ([bi, dAr, aAr, alt]) => {
      const g = (window as unknown as { __game: any }).__game;
      const body = g.bodies[bi as number];
      const V = body.center.constructor as new (x: number, y: number, z: number) => any;
      const d = new V((dAr as number[])[0], (dAr as number[])[1], (dAr as number[])[2]).normalize();
      const a = new V((aAr as number[])[0], (aAr as number[])[1], (aAr as number[])[2]).normalize();
      const probe = g.probe(d.asArray());
      g.ship.position.copyFrom(body.center).addInPlace(d.scale(probe.seaRadius + (alt as number)));
      g.state.landed = false;
      g.state.floating = false;
      // NB: FromLookDirectionLH aims the local -Z at the target, so negate.
      const Q = g.ship.rotationQuaternion.constructor as any;
      g.ship.rotationQuaternion.copyFrom(Q.FromLookDirectionLH(a.scale(-1), d));
    },
    [bodyIndex, dir, aim, above],
  );
}

/**
 * Nose direction for an orbit view: ~15 deg off straight-down. Looking exactly
 * down the local vertical degenerates the chase camera's up-vector.
 */
export async function orbitAim(page: Page, dir: Dir): Promise<Dir> {
  return page.evaluate((d: Dir) => {
    const ref = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const t = [ref[1] * d[2] - ref[2] * d[1], ref[2] * d[0] - ref[0] * d[2], ref[0] * d[1] - ref[1] * d[0]];
    const tl = Math.hypot(t[0], t[1], t[2]) || 1;
    return [
      -d[0] * 0.966 + (t[0] / tl) * 0.259,
      -d[1] * 0.966 + (t[1] / tl) * 0.259,
      -d[2] * 0.966 + (t[2] / tl) * 0.259,
    ];
  }, dir);
}

/** Collect page errors + console errors; filter favicon noise at assert time. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

/** Assert helper: no real errors (favicon 404s are ignored). */
export function expectNoErrors(errors: string[]): void {
  const real = errors.filter((e) => !e.includes("favicon"));
  if (real.length > 0) throw new Error(`Page errors:\n${real.join("\n")}`);
}
