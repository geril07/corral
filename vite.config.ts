import { defineConfig } from "vite-plus";

const IGNORED = [
  "**/node_modules/**",
  "**/dist/**",
  "**/out/**",
  "pnpm-lock.yaml",
  "apps/web/src/routeTree.gen.ts",
  // Verification evidence: append-only local artifacts, never source.
  "**/.e2e/**",
  "**/.playwright-cli/**",
];

const WEB_MODULES = [
  "board",
  "connection",
  "keymap",
  "projects",
  "sessions",
  "settings",
  "status",
  "tasks",
  "terminal",
  "workspace",
] as const;

const serverImport = {
  group: ["@corral/server", "@corral/server/**"],
  message: "Clients talk to the server over the protocol only.",
};

const baseUiImport = {
  group: ["@base-ui/react", "@base-ui/react/**"],
  message: "Base UI is used through common/ui only.",
};

const cmdkImport = {
  group: ["cmdk", "cmdk/**"],
  message: "cmdk is used through common/ui only.",
};

const lucideImport = {
  group: ["lucide-react", "lucide-react/**"],
  message: "Icons are used through common/ui only.",
};

/** Every module other than `own`, imported only through its public index.ts. */
function otherModules(own: string) {
  return WEB_MODULES.flatMap((module) =>
    module === own
      ? []
      : [
          `../${module}`,
          `../${module}/**`,
          `!../${module}/index.ts`,
          `../../${module}`,
          `../../${module}/**`,
          `!../../${module}/index.ts`,
          `../../../${module}`,
          `../../../${module}/**`,
          `!../../../${module}/index.ts`,
        ],
  );
}

const upFromCommon = [
  "../app/**",
  "../../app/**",
  "../../../app/**",
  "../routes/**",
  "../../routes/**",
  "../../../routes/**",
  "../modules/**",
  "../../modules/**",
  "../../../modules/**",
];

const upFromModule = [
  "../app/**",
  "../../app/**",
  "../../../app/**",
  "../routes/**",
  "../../routes/**",
  "../../../routes/**",
];

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  test: {
    // Flaky tests are fixed, not retried (docs/engineering.md).
    retry: 0,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["{apps,packages}/*/{src,test}/**/*.test.ts", "scripts/**/*.test.ts"],
          // node-pty and other native modules are unsafe in worker threads.
          pool: "forks",
          // Resource-budget policy: integration files each start a real server or PTY, so half
          // the cores leaves headroom for the host instead of Vitest's run-mode default CPUs - 1.
          maxWorkers: "50%",
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
        // Raw DOM controls and inline styles only exist inside the UI kit.
        files: ["apps/web/src/**/*.tsx"],
        excludeFiles: ["apps/web/src/common/ui/**"],
        plugins: ["react"],
        rules: {
          "react/forbid-dom-props": [
            "error",
            {
              forbid: [
                { propName: "style", message: "Style through common/ui, not a style prop." },
              ],
            },
          ],
          "react/forbid-elements": [
            "error",
            {
              forbid: [
                { element: "button", message: "Use Button from common/ui." },
                { element: "input", message: "Use Input or a common/ui field control." },
                { element: "select", message: "Use a common/ui control." },
                { element: "textarea", message: "Use a common/ui control." },
                { element: "dialog", message: "Use a common/ui dialog composition." },
                { element: "a", message: "Use TextLink from common/ui." },
                { element: "label", message: "Use a common/ui field composition." },
                { element: "fieldset", message: "Use FieldSet from common/ui." },
                { element: "legend", message: "Use FieldLegend from common/ui." },
              ],
            },
          ],
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
        files: ["packages/client/**"],
        rules: {
          "eslint/no-restricted-imports": ["error", { patterns: [serverImport] }],
        },
      },
      {
        // The kit is the only place that imports Base UI.
        files: ["apps/web/src/common/ui/**"],
        rules: {
          "eslint/no-restricted-imports": ["error", { patterns: [serverImport] }],
        },
      },
      {
        // common -> nothing above it (app, routes, modules).
        files: ["apps/web/src/common/**"],
        excludeFiles: ["apps/web/src/common/ui/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              patterns: [
                serverImport,
                baseUiImport,
                cmdkImport,
                lucideImport,
                { group: upFromCommon, message: "common imports nothing above it." },
              ],
            },
          ],
        },
      },
      {
        // A module may use common and another module's public index.ts; never app or routes.
        files: ["apps/web/src/modules/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              patterns: [
                serverImport,
                baseUiImport,
                cmdkImport,
                lucideImport,
                {
                  group: upFromModule,
                  message: "A module does not import app or routes.",
                },
              ],
            },
          ],
        },
      },
      ...WEB_MODULES.map((module) => ({
        files: [`apps/web/src/modules/${module}/**`],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              patterns: [
                serverImport,
                baseUiImport,
                cmdkImport,
                lucideImport,
                {
                  group: upFromModule,
                  message: "A module does not import app or routes.",
                },
                {
                  group: otherModules(module),
                  message: "Another module is imported through its index.ts only.",
                },
              ],
            },
          ],
        },
      })),
      {
        // Routes compose modules through their index.ts and do not import app.
        files: ["apps/web/src/routes/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              patterns: [
                serverImport,
                baseUiImport,
                cmdkImport,
                lucideImport,
                {
                  group: ["../app/**", "../../app/**", "../modules/**", "!../modules/*/index.ts"],
                  message: "Routes import modules through their public index.ts.",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["apps/web/src/app/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            { patterns: [serverImport, baseUiImport, cmdkImport, lucideImport] },
          ],
        },
      },
      {
        // Test fixtures and the Vite config are outside the UI layering.
        files: ["apps/web/**"],
        excludeFiles: ["apps/web/src/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            { patterns: [serverImport, baseUiImport, cmdkImport, lucideImport] },
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
