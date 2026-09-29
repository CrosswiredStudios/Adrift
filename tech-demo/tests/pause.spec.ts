import { test, expect } from "@playwright/test";
import { expectNoErrors, sharedGame } from "./helpers";

const shared = sharedGame();

const overlayVisible = (): boolean =>
  document.getElementById("pause")?.classList.contains("visible") ?? false;

test("Esc pauses with an overlay, freezes the sim, and resumes", async () => {
  const page = shared.page();
  expect(await page.evaluate(overlayVisible)).toBe(false);

  await page.keyboard.press("Escape");
  await page.waitForFunction(overlayVisible);
  const t0 = await page.evaluate(() => (window as any).__game.time());
  await page.waitForTimeout(2500);
  const t1 = await page.evaluate(() => (window as any).__game.time());
  expect(t1).toBe(t0); // no real-time simulation while paused
  // The controls list is generated from the live bindings.
  const controls = await page.evaluate(() => document.querySelector(".pause-controls")?.textContent ?? "");
  expect(controls).toContain("W/S");

  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => !(document.getElementById("pause")?.classList.contains("visible") ?? true),
  );
  expect(await page.evaluate(() => (window as any).__game.paused())).toBe(false);

  // The Resume button also works.
  await page.keyboard.press("Escape");
  await page.waitForFunction(overlayVisible);
  await page.click("#resume");
  await page.waitForFunction(
    () => !(document.getElementById("pause")?.classList.contains("visible") ?? true),
  );
  expect(await page.evaluate(() => (window as any).__game.paused())).toBe(false);
  expectNoErrors(shared.errors());
});
