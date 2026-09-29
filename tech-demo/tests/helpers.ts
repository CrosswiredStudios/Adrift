/**
 * Shared Playwright fixtures.
 *
 * Headless software GL renders a few frames per second and compiles shaders
 * slowly, so every spec boots the game once (serial describe + a shared
 * page) and drives the simulation through `window.__game.step(seconds)`
 * (whole fixed steps, no rendering). Visual state is refreshed with
 * `__game.render()` when a test needs it.
 */
import { Browser, Page, test } from "@playwright/test";

/** Load the app and wait for the debug handle. */
export async function boot(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "load" });
  await page.waitForFunction(() => (window as unknown as { __game?: unknown }).__game !== undefined, null, {
    timeout: 120000,
  });
}

/** Collect page errors + console errors. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

export function expectNoErrors(errors: string[]): void {
  if (errors.length > 0) throw new Error(`Page errors:\n${errors.join("\n")}`);
}

/**
 * One booted page shared by every test in the calling file (tests run in
 * order). Returns accessors for the page and its collected errors.
 */
export function sharedGame(): { page: () => Page; errors: () => string[] } {
  let page: Page;
  let errors: string[] = [];
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    page = await browser.newPage();
    errors = collectErrors(page);
    await boot(page);
  });
  test.afterAll(async () => {
    await page?.close();
  });
  return { page: () => page, errors: () => errors };
}

/** Wait (real time) until streaming terrain/vegetation near the camera is done. */
export async function waitSettled(page: Page, timeoutMs = 300000): Promise<boolean> {
  try {
    await page.waitForFunction(
      () => {
        const g = (window as unknown as { __game: any }).__game;
        return g.settled();
      },
      null,
      { timeout: timeoutMs, polling: 1000 },
    );
    return true;
  } catch {
    return false;
  }
}
