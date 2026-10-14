import { defineConfig } from "@playwright/test";

// Electron is the browser (_electron.launch in the spec): no Playwright browsers to install.
export default defineConfig({
  testDir: "e2e",
  timeout: 10 * 60_000,
  workers: 1,
  reporter: "list",
});
