import { defineConfig } from "vite-plus";

export default defineConfig({
  // Separate entries so each output is self-contained: a sandboxed Electron preload cannot
  // require a sibling chunk.
  pack: [
    {
      entry: ["src/main.ts"],
      format: "esm",
      platform: "node",
      deps: { neverBundle: ["electron"] },
    },
    {
      entry: ["src/preload.ts"],
      format: "cjs",
      platform: "node",
      deps: { neverBundle: ["electron"] },
    },
  ],
});
