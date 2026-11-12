import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";
import { createGitRepo, createGitRepoWithRemote } from "./test/git-repos.ts";
import { runGitIn } from "./test/run-git.ts";
import { removeDirectoryIn } from "./test/remove-directory.ts";
import { writeFilesIn } from "./test/write-files.ts";
import { writeConfigFile } from "./test/config-file.ts";
import { clearIssueCliCalls, issueCliCalls, issueCliPath } from "./test/issue-clis.ts";
import { writeRepoFile } from "./test/repo-files.ts";
import { agentLaunches, serverEnv } from "./test/server-agents.ts";
import { WeightedShardSequencer } from "./test/weighted-shard-sequencer.ts";

export default defineConfig({
  // Relative asset paths so Electron can load the build from a file:// URL.
  base: "./",
  // New primitive entry points must be prebundled to avoid a test reload splitting React.
  optimizeDeps: {
    include: [
      "@base-ui/react/autocomplete",
      "@base-ui/react/toast",
      "@base-ui/react/checkbox",
      "@base-ui/react/context-menu",
      "@base-ui/react/popover",
      "@base-ui/react/toolbar",
    ],
  },
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
    retry: 0,
    sequence: { sequencer: WeightedShardSequencer },
    browser: {
      enabled: true,
      headless: true,
      // The desktop minimum (`docs/layout.md`); a phone-sized iframe tests a layout
      // the app does not support and hides the ones it does.
      viewport: { width: 1024, height: 640 },
      provider: playwright(),
      commands: {
        createGitRepo,
        createGitRepoWithRemote,
        writeFilesIn,
        runGitIn,
        removeDirectoryIn,
        agentLaunches,
        serverEnv,
        writeRepoFile,
        writeConfig: writeConfigFile,
        issueCliCalls,
        clearIssueCliCalls,
        issueCliPath,
      },
      instances: [{ browser: "chromium" }],
    },
  },
});
