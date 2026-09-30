import { test, expect } from "@playwright/test";
import { expectNoErrors, sharedGame } from "./helpers";

const shared = sharedGame();

test("salvage, board and scan advance the objective chain", async () => {
  const page = shared.page();
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    g.freeze();
    g.reset();
    const o0 = g.objective();
    g.gotoPoi("pod");
    g.step(0.1);
    const near = g.interactable();
    g.interact();
    const inv = g.inventory();
    const o1 = g.objective();
    return { o0, near, inv, o1 };
  });
  expect(res.o0).toBe("Salvage the escape pod");
  expect(res.near).toBe("pod");
  expect(res.inv.scrap).toBe(4);
  expect(res.o1).toBe("Reach the skiff on the survey pad");

  // The inventory panel lists the loot and a craftable hull patch.
  await page.evaluate(() => (window as any).__game.setInventoryOpen(true));
  await page.evaluate(() => (window as any).__game.render());
  const panel = await page.evaluate(() => document.querySelector(".hud-inventory")?.textContent ?? "");
  expect(panel).toContain("4 x Scrap");
  await page.click('.hud-inventory button[data-recipe="hullPatch"]');
  expect(await page.evaluate(() => (window as any).__game.inventory().scrap)).toBe(2);
  await page.evaluate(() => (window as any).__game.setInventoryOpen(false));

  const res2 = await page.evaluate(() => {
    const g = (window as any).__game;
    g.gotoPoi("ruin-shore");
    g.step(0.1);
    g.interact();
    return { discovered: [...g.progression.discoveries], objective: g.objective() };
  });
  expect(res2.discovered).toContain("glyphs-basic");
  // Boarding is still the current objective; the shore scan is remembered for later.
  expect(res2.objective).toBe("Reach the skiff on the survey pad");
  const lore = await page.evaluate(() => document.querySelector(".hud-lore")?.textContent ?? "");
  expect(lore).toContain("Shore glyphs");
  expectNoErrors(shared.errors());
});

test("save and load restore position, mode and progress", async () => {
  const page = shared.page();
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    g.freeze();
    g.placeShip("vael", 27, 97, 120, 45);
    g.setMode("ship");
    g.step(0.5);
    const saved = {
      pos: g.sim.ship.pos.asArray(),
      time: g.time(),
      inv: g.inventory(),
      objective: g.objective(),
    };
    const ok = g.save();
    // Wander off and lose stuff.
    g.reset();
    g.step(3);
    g.progression.take("scrap", 2);
    const loaded = g.load();
    return {
      ok,
      loaded,
      saved,
      pos: g.sim.ship.pos.asArray(),
      time: g.time(),
      mode: g.mode(),
      inv: g.inventory(),
      objective: g.objective(),
    };
  });
  expect(res.ok).toBe(true);
  expect(res.loaded).toBe(true);
  expect(res.mode).toBe("ship");
  expect(res.time).toBeCloseTo(res.saved.time, 6);
  expect(Math.hypot(...res.pos.map((v: number, i: number) => v - res.saved.pos[i]))).toBeLessThan(1e-6);
  expect(res.inv).toEqual(res.saved.inv);
  expect(res.objective).toBe(res.saved.objective);

  // The pause menu offers Save / Load.
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("pause")?.classList.contains("visible"));
  await page.click("#load");
  await page.waitForFunction(() => !document.getElementById("pause")?.classList.contains("visible"));
  expectNoErrors(shared.errors());
});
