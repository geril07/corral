# Corral

Keyboard-first workspace for running coding agents in terminals: a long-lived Node server plus web, desktop and (later) mobile clients.

- Product decisions and why: `docs/design.md`. Read before changing behavior, protocol or architecture.
- Layout, toolchain, code organization and testing rules: `docs/engineering.md`. Read before adding a package, a dependency or a test.

## Commands

Node and pnpm come from `mise.toml`. `pnpm check` is the gate before every commit: format, lint, type check, Node tests. Browser and Electron suites: `pnpm test:browser`, `pnpm test:e2e`.

## Commits

Conventional Commits: `type(scope): summary`, scope = package or app (`protocol`, `server`, `client`, `web`, `desktop`) or `docs`/`tooling`. Parallel work goes on `<milestone>/<part>` branches merged into `main` with `--no-ff`, so each merge marks a checkpoint.

## Gotchas

- All code runs as erasable TypeScript straight from source: relative imports end in `.ts`, no enums, namespaces or parameter properties.
- Inside a workspace, `vp fmt`/`vp lint`/`vp check` are Vite+ built-ins; `vpr <script>` runs the package.json script of the same name.
- The Electron entry (`apps/desktop/src/main.ts`) must not use top-level `await`: Playwright's Electron launcher hangs on it.
- Playwright sends keys over CDP, past Electron's native menu, so menu-related keyboard behavior cannot be tested end to end.
- `vite` is aliased to Vite+'s core in `pnpm-workspace.yaml`, so peer warnings about `vite` versions are expected. Keep the alias and the `vitest` pin in step with `vite-plus` when upgrading.
