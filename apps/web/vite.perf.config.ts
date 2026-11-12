import { defineConfig } from "vite-plus";
import base from "./vite.config.ts";

/**
 * The isolated timing suite. It reuses the browser project's plugins, setup, server and commands,
 * but runs only `*.perf.browser.test.tsx` in one process: shard load is what made the 10,000-item
 * p95 budget red in the normal gate.
 */
const {
  sequence: _sequence,
  exclude: _exclude,
  include: _include,
  ...browserTest
} = base.test ?? {};

export default defineConfig({
  ...base,
  test: {
    ...browserTest,
    name: "browser-perf",
    include: ["src/**/*.perf.browser.test.tsx"],
    fileParallelism: false,
  },
});
