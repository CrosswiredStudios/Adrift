import { defineConfig } from "@playwright/test";

// Node global (the project doesn't pull in @types/node just for this).
declare const process: { env: Record<string, string | undefined> };

/**
 * End-to-end suites. The game renders with software WebGL (SwiftShader) in
 * headless Chromium, which is slow: each spec file boots the game once and
 * shares the page between its (serial) tests, and simulation is driven
 * with `window.__game.step()` rather than real time.
 */
export default defineConfig({
  testDir: "./tests",
  // Screenshot/diagnostic scripts (no assertions) run only on demand via
  // playwright.diagnostics.config.ts (`npm run test:shots`).
  testIgnore: ["**/diagnostics/**"],
  timeout: 180000,
  // Software GL is CPU bound: more than two browsers at once just thrash.
  workers: process.env.CI ? 1 : 2,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://localhost:4173",
    launchOptions: {
      args: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
      ],
    },
  },
  webServer: {
    // Always serve a fresh build: `test:e2e` rebuilds first (see package.json),
    // and reuseExistingServer is off so a stale preview on :4173 fails loudly
    // instead of silently passing against an old bundle.
    command: "npx vite preview --port 4173 --strictPort",
    port: 4173,
    reuseExistingServer: false,
    timeout: 60000,
  },
});
