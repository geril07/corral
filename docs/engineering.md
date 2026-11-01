# Engineering

How the code is laid out, built and tested. Product decisions are in `design.md`; this document is the technical side.

## Toolchain

| Concern                       | Choice                                                               | Why                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime (server)              | Node 26 LTS, pinned via mise                                         | node-pty is a Node binding. Bun was considered and rejected for now: its PTY API cannot pause reads (we need that for backpressure; [bun#41410](https://github.com/oven-sh/bun/issues/41410)), node-pty under Bun loses input/output ([bun#25822](https://github.com/oven-sh/bun/issues/25822)), and there are open controlling-terminal and long-run PTY allocation reports. Revisit when PTY pause/resume lands. |
| Package manager               | pnpm workspaces + catalogs                                           | Both references use it; Electron packagers expect its layout more than Bun's.                                                                                                                                                                                                                                                                                                                                      |
| Dev/build/test/lint/fmt/tasks | Vite+ 1.x (`vp`), MIT                                                | One CLI over Vite, Vitest, Oxlint, Oxfmt, tsdown and a cached task runner. T3 Code uses it. Coupling risk: `vite` and `vitest` versions must match the ones Vite+ bundles.                                                                                                                                                                                                                                         |
| Lint                          | Oxlint with type-aware rules (tsgolint)                              | 870+ rules incl. React, hooks, import, vitest; type-aware is stable. React Compiler rules are experimental; enable and watch. No ESLint unless a needed rule is missing.                                                                                                                                                                                                                                           |
| Format                        | Oxfmt                                                                | Prettier-compatible, no Prettier plugins needed.                                                                                                                                                                                                                                                                                                                                                                   |
| Types                         | TypeScript 7 (`tsc -b`) for type checking and the editor             | Bundlers only strip types. TS 7.0 has no compiler API; nothing we use needs it (lint goes through tsgolint).                                                                                                                                                                                                                                                                                                       |
| Validation                    | zod 4                                                                | Wire schemas shared by server and clients; tRPC accepts it.                                                                                                                                                                                                                                                                                                                                                        |
| Electron main                 | `vp pack` (tsdown) into one ESM file                                 | The renderer is `apps/web` with its own Vite dev server, so electron-vite would only build a single main file. Revisit if a preload script needs HMR.                                                                                                                                                                                                                                                              |
| React Compiler                | `@vitejs/plugin-react` with `compiler: true` + `oxc-transform-react` | plugin-react 6 runs the compiler through Oxc, not Babel.                                                                                                                                                                                                                                                                                                                                                           |
| Packaging                     | electron-builder                                                     | Handles pnpm workspaces and native modules, has AppImage, deb, rpm and pacman targets; `electron-updater` updates AppImage/deb/rpm/pacman on Linux and NSIS on Windows. Forge's updater has no Linux path and its crawler wants `node-linker=hoisted`. T3 Code and Orca both use electron-builder.                                                                                                                 |

Commands are root scripts over `vp`: `pnpm check` (format check, lint, type check, Node tests), `pnpm test:browser`, `pnpm test:e2e`, `pnpm dev`. Vitest has two projects: `node` (every `*.test.ts`, forks pool) and `browser` (`apps/web`, `*.browser.test.tsx`).

## Repository layout

```
apps/
  server/     long-lived server: PTYs, tasks, sessions, git, status, RPC + terminal sockets
  web/        React client (runs in Electron and in a browser)
  desktop/    Electron shell: window, starts/finds the server, loads web
packages/
  protocol/   wire contracts: zod schemas, oRPC contract, terminal stream messages, protocol version
  client/     framework-agnostic client runtime: RPC client, terminal stream client with acks,
              reconnect, stores; shared by web now and mobile later
docs/
```

Dependency direction, enforced by lint (import boundaries):

- `protocol` depends on nothing internal.
- `server` → `protocol`. `client` → `protocol`. `web` → `client`, `protocol`.
- `desktop` → `protocol` (the server endpoint file contract only); it starts the server and loads the web bundle.
- Nothing imports `server` except tests. Its own tests import it normally; tests of `client` and `web` start the real server through a relative import (`packages/client/test/server-fixture.ts`, `apps/web/test/real-server.ts`), because a package dependency would be a cycle (`server` already uses `client` in its tests). A client never reaches into server code for types; shared types live in `protocol`.

Internal packages export TypeScript source (no build step). The server runs that source directly in Node, so all code is restricted to erasable TypeScript (`erasableSyntaxOnly`: no enums, namespaces or parameter properties) and relative imports carry `.ts` extensions. The production server is bundled into one file with `vp pack`. Verified: Node 26 runs the server from source, including workspace packages reached through pnpm symlinks.

## Code organization

- **By domain, not by layer.** `apps/server/src/{tasks,sessions,pty,status,git,storage,transport}`; each folder owns its logic, its IO and its tests.
- **Pure logic apart from IO.** State transitions and parsing (task status from agent reports, OSC 7501 parsing, keymap resolution, session switching rules) are plain functions over plain data. IO (node-pty, SQLite, git, sockets) sits in thin modules that call them.
- **Thin transport.** RPC handlers validate input, call a domain function, map errors. No logic in handlers.
- **Stores in `packages/client` are framework-agnostic** (subscribe/getSnapshot); React reads them with `useSyncExternalStore`. Mobile reuses them as is.
- **Terminals stay imperative.** Output goes from the stream client straight into `terminal.write()`, never through React state.
- **Names are concrete.** No `utils`, `helpers`, `common`, `misc` (Orca's rule): a module is named after what it does.
- **The local capability is part of the transport contract.** `ServerEndpoint` carries the per-run capability; clients take a `ServerTarget` and present it as a WebSocket subprotocol (`packages/protocol/src/handshake.ts`). Desktop re-reads the endpoint file for every preload IPC request and clients ask for the current `ServerTarget` before each reconnect, so a restarted server is picked up without an app restart. Browser/dev stores the URL and capability together and only reuses the pair for the same server URL (`packages/client/src/bootstrap.ts`). Never append the capability to a URL or log it.
- **Protocol changes are versioned.** Client and server exchange `PROTOCOL_VERSION` on connect and refuse a mismatch; new fields are optional within a version, but a release barrier bumps the version when an older daemon would silently ignore them (version 3 adds launch profiles/model fields; version 4 adds the settings action and its exhaustive bindings key; version 5 prevents older daemons stripping task-source inputs; version 6 adds the task title source, the rename-task/session-number actions with their exhaustive bindings, and the required task/naming/project settings; version 7 adds the sidebar-mode action, the server-owned task `seenAt` and the task's prompt and primary session; version 7 never left the trunk, so the task's new required fields joined it instead of waiting for a version of their own; version 8 adds the toggle-sidebar action and its binding).

## Web UI kit

Stock default shadcn/ui Base UI / Nova components live in `apps/web/src/common/ui`.
Canonical theme/type/radius and primitive visual defaults come from the official CLI;
modules must use kit variants instead of class/style overrides on controls. The AST
gate covers imported aliases, namespaces, field/command wrappers and opaque prop spreads.
Generation commands, provenance, token mapping and intentional adaptations:
[`ui-kit.md`](ui-kit.md). Modules compose the kit; they do not import Base UI,
cmdk or icons directly. Keep the UI-boundary lint and class/token gates active.

## Testing

Philosophy: test observable behavior through real dependencies. Fakes only where the real thing is expensive or nondeterministic.

| Layer              | What                                                                                                                                    | Tool                                                                                                                 | Where                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Unit               | Pure logic: parsers, state transitions, keymap                                                                                          | Vitest; fast-check (`fc.assert`) for parsers                                                                         | `*.test.ts` next to code                                  |
| Server integration | Domain behavior through real SQLite (temp file), real PTYs, real git repos (temp dir), real WebSocket server on port 0, fake agent CLIs | Vitest, `pool: 'forks'`                                                                                              | `*.test.ts` next to code; fixtures in `apps/server/test/` |
| Browser            | Components and xterm integration in real Chromium, real keyboard events                                                                 | Vitest Browser Mode + Playwright provider                                                                            | `*.browser.test.tsx`                                      |
| End to end         | Desktop app against a real server; web client in a browser against a real server                                                        | Playwright (`_electron`, experimental); locally in a private headless sway (`scripts/headless.sh`), Xvfb on Linux CI | `apps/desktop/e2e/`, `apps/web/e2e/`                      |
| Agent contracts    | Real agent CLIs still behave as the fakes assume (flags, OSC 7501, session ids)                                                         | Vitest, opt-in (`pnpm test:contracts`), not in CI                                                                    | `apps/server/test/contracts/`                             |

**Fake agents** are small executables on `PATH` named `claude`, `codex`, `pi`, `opencode`. A script decides what they print (including OSC 7501), what input they wait for, and when they exit, and they log the arguments they were called with. They run in a real PTY. Contract tests keep them honest against the real CLIs.

Guidelines:

1. Test behavior a user or caller can observe, at the lowest layer that catches the regression. Extend an existing test before adding a new one.
2. Do not mock our own code or types we do not own. Use the real SQLite, PTY, socket, git and filesystem in temp dirs.
3. Fake only expensive or nondeterministic externals: agent CLIs (fake executables), paid APIs, and time or randomness when they are the behavior under test.
4. Never wait with a bare sleep. Wait for an observable signal (output, event, exit, readiness line) with a deadline.
5. Every test cleans up what it started: PTYs, process trees, sockets, temp dirs, also on failure.
6. Servers in tests listen on port 0 and report the assigned port; each test gets its own data directory.
7. Keymap tests send real key events (Browser Mode) and assert on `KeyboardEvent.code` and modifiers.
8. Parsers get property tests: output does not depend on chunk boundaries; malformed input never throws or hangs. Keep failing seeds as regular tests.
9. Visual assertions (screenshots) only in a pinned browser and OS environment.
10. Native-module suites run in forks. No retries by default; a test that passes on retry is a bug to fix, not a pass.
11. A test that restates the implementation is deleted, not maintained.

## Open

- **Shipping the server.** Proposed: ship an official Node binary with the app and, on first start of a version, copy it with the bundled server and node-pty into a versioned directory outside the install tree (`~/.local/share/corral/server/<version>/`), then run it from there detached. Why: dev, tests and production run the same Node (Electron 45 embeds Node 24, we develop on 26); node-pty needs no Electron ABI rebuild; the `runAsNode` fuse can be turned off; an app update cannot delete files under a running server (Orca hit this on Windows and relocates the same way). `utilityProcess` is out: it cannot be detached. Not verified: AppImage and macOS bundle behavior during an update with the old server still running.
- **Server/app version skew** after an update: the handshake refuses a mismatch; who stops the old server and when is still to be designed.
- **Server bundling and the OpenCode plugin.** `apps/server/src/status/opencode-integration.ts` reads the plugin file relative to its own module; bundling the server with `vp pack` must copy it or inline it.
