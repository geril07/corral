import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";
import { createGitRepo } from "./test/git-repos.ts";

export default defineConfig({
  // Relative asset paths so Electron can load the build from a file:// URL.
  base: "./",
  plugins: [react({ compiler: true })],
  test: {
    name: "browser",
    include: ["src/**/*.browser.test.tsx"],
    globalSetup: ["test/real-server.ts"],
    // The files share one real server, and each test cleans up all of it afterwards.
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      commands: { createGitRepo },
      instances: [{ browser: "chromium" }],
    },
  },
});
