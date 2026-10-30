import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // Flaky tests are fixed, not retried (docs/engineering.md).
  retries: 0,
  reporter: "list",
});
