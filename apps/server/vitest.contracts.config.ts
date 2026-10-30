import { defineConfig } from "vite-plus";

// Opt-in (`pnpm test:contracts`): talks to the agent CLIs installed on this machine, so it is
// not part of `check` or CI.
export default defineConfig({
  test: {
    name: "contracts",
    environment: "node",
    include: ["test/contracts/**/*.contract.ts"],
    retry: 0,
    pool: "forks",
  },
});
