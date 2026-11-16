# Corral

Keyboard-first workspace for running coding agents in terminals: a long-lived Node server plus web, desktop and (later) mobile clients.

- Server, clients, protocol, agent sessions, data ownership or trust: read `docs/architecture.md` for boundaries and reasons.
- Reference checkouts, never bases: `.refs/t3code` (visual, composition, chat, type) and `.refs/orca`
  (terminal, status, daemon). Gitignored; refresh with `git -C .refs/<name> pull`.
- Code organization, dependencies or tests: read `docs/engineering.md`.

## Commands

`pnpm check` is the static gate: UI kit guard, format, lint, type check. `pnpm verify` is the full pack: the static gate plus the Node, browser and Electron suites. Browser and Electron files on their own: `pnpm test:browser`, `pnpm test:e2e`.

## Local workloads

Before launching local workloads on the Linux agent host, read `docs/workrun.md` for Corral's
entrypoints, group and heavy classification.

## Verification

- **Focused, and the default.** Run what the change can break: the test file next to the code, that package's type check, format and lint of the files touched, and the browser or Electron file when the change reaches a surface a user or client can use. Per-file commands: `docs/engineering.md`, **Testing**.
- **Full pack, for a broad or undeterminable change.** Protocol, layout, build or config shapes, anything spanning packages, or a surface whose tests you cannot name: `pnpm verify`, which runs every suite, so nothing is selected by judgement.
- The PR says what ran and what did not. A focused run makes a smaller claim, not the same one under another name: name the suites that did not run. An unstated skip is the failure this rule exists to prevent; the full pack is the evidence a release needs, not the edit loop.

## UI work

- A pattern that exists in T3 or OpenCode is taken from there (T3: structure, geometry, behaviour;
  OpenCode: visual language). A pattern that exists in neither is new work and is reviewed as such.
- Do not invent user-visible copy. No reference wording and no functional error means no sentence.
- Before changing UI, read `docs/ui-kit.md` for visual direction and kit boundaries. Publish
  before/after screenshots as specified in `.github/pull_request_template.md`.

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
