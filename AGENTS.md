# Corral

Keyboard-first workspace for running coding agents in terminals: a long-lived Node server plus web, desktop and (later) mobile clients.

- Product decisions and why: `docs/design.md`. Read before changing behavior, protocol or architecture.
- Layout, toolchain, code organization and testing rules: `docs/engineering.md`. Read before adding a package, a dependency or a test.

## Commands

`pnpm check` is the full gate: format, lint, type check, Node tests. Browser and Electron suites: `pnpm test:browser`, `pnpm test:e2e`.

## Verification

- Run what the change can break, not the whole pipeline: the test file next to the code, that package's type check, format and lint of the files touched. Per-file commands: `docs/engineering.md`, **Testing**.
- Broad or undeterminable change — protocol, layout, build or config shapes, anything spanning packages — gets the full gate: `pnpm check`, plus `pnpm test:browser` and `pnpm test:e2e` where the changed surface is one a user or client can reach.
- The PR says what ran and what did not. An unstated skip is the failure this rule exists to prevent; the full suites are the evidence a release needs, not the edit loop.

## Issues and pull requests

- A change starts from a GitHub issue: `gh issue view N` for the report and the decision it settles. Bugs, features and behaviour changes alike.
- Branch `<type>/<issue>-<slug>` (`fix/1-tilde-path`); the PR body ends with `Closes #N`.
- One PR per issue, rebased onto `main` and merged with rebase-and-merge, so history stays linear.

## Commits

Conventional Commits (`type(scope): summary`, scope = package or app), checked by the `commit-msg` hook; `pre-commit` formats and lints staged files. History is linear: work branches are rebased onto `main` and fast-forwarded, never merged.

## Gotchas

- All code runs as erasable TypeScript straight from source: relative imports end in `.ts`, no enums, namespaces or parameter properties.
- Inside a workspace, `vp fmt`/`vp lint`/`vp check` are Vite+ built-ins; `vpr <script>` runs the package.json script of the same name.
- The Electron entry (`apps/desktop/src/main.ts`) must not use top-level `await`: Playwright's Electron launcher hangs on it.
- Playwright sends keys over CDP, past Electron's native menu, so menu-related keyboard behavior cannot be tested end to end.
- `vite` is aliased to Vite+'s core in `pnpm-workspace.yaml`, so peer warnings about `vite` versions are expected. Keep the alias and the `vitest` pin in step with `vite-plus` when upgrading.
