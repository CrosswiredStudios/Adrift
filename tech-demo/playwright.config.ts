import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 90000,
  use: {
    baseURL: "http://localhost:4173",
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
