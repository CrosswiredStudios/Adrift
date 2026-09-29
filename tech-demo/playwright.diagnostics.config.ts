import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/** Screenshot/diagnostic scripts in tests/diagnostics (no pass/fail value). */
export default defineConfig({
  ...base,
  testDir: "./tests/diagnostics",
  testIgnore: [],
  timeout: 300000,
});
