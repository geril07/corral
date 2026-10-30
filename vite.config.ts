import { defineConfig } from "vite-plus";

const IGNORED = ["**/node_modules/**", "**/dist/**", "**/out/**", "pnpm-lock.yaml"];

export default defineConfig({
  test: {
    // Flaky tests are fixed, not retried (docs/engineering.md).
    retry: 0,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["{apps,packages}/*/{src,test}/**/*.test.ts"],
          // node-pty and other native modules are unsafe in worker threads.
          pool: "forks",
        },
      },
      "apps/web",
    ],
  },
  fmt: {
    ignorePatterns: IGNORED,
    printWidth: 100,
  },
  lint: {
    ignorePatterns: IGNORED,
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "vitest"],
    categories: { correctness: "error", suspicious: "warn", perf: "warn" },
    options: { typeAware: true, reportUnusedDisableDirectives: "error" },
    rules: {
      "eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "typescript/no-floating-promises": "error",
      "import/no-cycle": "error",
    },
    overrides: [
      {
        files: ["apps/web/**/*.tsx"],
        plugins: ["react"],
        rules: {
          // The automatic JSX runtime needs no React import.
          "react/react-in-jsx-scope": "off",
          "react/rules-of-hooks": "error",
          "react/purity": "error",
          "react/immutability": "error",
          "react/set-state-in-render": "error",
        },
      },
      {
        // Dependency direction (docs/engineering.md): protocol is a leaf, clients never import the server.
        files: ["packages/protocol/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              patterns: [
                { group: ["@corral/**"], message: "protocol depends on nothing internal." },
              ],
            },
          ],
        },
      },
      {
        files: ["packages/client/**", "apps/web/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["@corral/server", "@corral/server/**"],
                  message: "Clients talk to the server over the protocol only.",
                },
              ],
            },
          ],
        },
      },
      {
        // The desktop shell may read the server's endpoint file contract, nothing else internal.
        files: ["apps/desktop/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["@corral/**", "!@corral/protocol", "!@corral/protocol/**"],
                  message: "The desktop shell imports only @corral/protocol.",
                },
              ],
            },
          ],
        },
      },
    ],
  },
});
