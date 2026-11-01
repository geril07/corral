import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";
import { createGitRepo } from "./test/git-repos.ts";
import { runGitIn } from "./test/run-git.ts";
import { writeFilesIn } from "./test/write-files.ts";
import { writeConfigFile } from "./test/config-file.ts";
import { clearIssueCliCalls, issueCliCalls, issueCliPath } from "./test/issue-clis.ts";
import { agentLaunches, serverEnv } from "./test/server-agents.ts";

export default defineConfig({
  // Relative asset paths so Electron can load the build from a file:// URL.
  base: "./",
  plugins: [
    tanstackRouter({
      target: "react",
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
      autoCodeSplitting: false,
    }),
    react({ compiler: true }),
    tailwindcss(),
  ],
  test: {
    name: "browser",
    include: ["src/**/*.browser.test.tsx"],
    setupFiles: ["./test/setup.ts"],
    globalSetup: ["test/real-server.ts"],
    // The files share one real server, and each test cleans up all of it afterwards.
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      // The desktop minimum (`ux.md`, **Known limits**); a phone-sized iframe tests a layout
      // the app does not support and hides the ones it does.
      viewport: { width: 1024, height: 640 },
      provider: playwright(),
      commands: {
        createGitRepo,
        writeFilesIn,
        runGitIn,
        agentLaunches,
        serverEnv,
        writeConfig: writeConfigFile,
        issueCliCalls,
        clearIssueCliCalls,
        issueCliPath,
      },
      instances: [{ browser: "chromium" }],
    },
  },
});
