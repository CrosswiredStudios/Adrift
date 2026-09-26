import { test, expect } from "@playwright/test";
import { boot, collectErrors, expectNoErrors, stepFrames } from "./helpers";

test("Esc pauses the sim with an overlay and resumes", async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);

  // Overlay starts hidden and the game unpaused.
  const initial = await page.evaluate(() => ({
    visible: document.getElementById("pause")?.classList.contains("visible") ?? false,
    paused: (window as unknown as { __game: any }).__game.paused(),
  }));
  expect(initial.visible).toBe(false);
  expect(initial.paused).toBe(false);

  // Esc opens the overlay and freezes the sim across realtime frames.
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => document.getElementById("pause")?.classList.contains("visible") === true,
  );
  const frozen = await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    return { paused: g.paused(), pos: g.ship.position.asArray() };
  });
  expect(frozen.paused).toBe(true);
  await page.waitForTimeout(2500);
  const still = await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    return { paused: g.paused(), pos: g.ship.position.asArray() };
  });
  expect(still.paused).toBe(true);
  expect(still.pos).toEqual(frozen.pos);

  // Esc toggles back off; the sim advances again via deterministic steps.
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => document.getElementById("pause")?.classList.contains("visible") === false,
  );
  expect(await page.evaluate(() => (window as unknown as { __game: any }).__game.paused())).toBe(
    false,
  );
  await stepFrames(page, 60, 1 / 60);

  // The Resume button path also pauses and resumes.
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => document.getElementById("pause")?.classList.contains("visible") === true,
  );
  await page.click("#resume");
  await page.waitForFunction(
    () => document.getElementById("pause")?.classList.contains("visible") === false,
  );
  expect(await page.evaluate(() => (window as unknown as { __game: any }).__game.paused())).toBe(
    false,
  );
  expectNoErrors(errors);
});
