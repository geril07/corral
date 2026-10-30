# Design

A keyboard-first workspace for running coding agents, for people who live in the terminal.
Replaces Herdr for its author; Orca and T3 Code (`.refs/`) are references, not bases.
Client UI rules: `ux.md`.

## Decisions

| #   | Decision                                                                                   | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Terminal engine: xterm.js + WebGL                                                          | The spike held ~60 fps with 8 agent panes and under flood. libghostty-vt stays behind `PLAYTEST_TERM=ghostty`; it did not win (README, "Findings").                                                                                                                                                                                                                                                                                                                                                       |
| 2   | Client/server split from day one; one web client for Electron and the browser              | Agents keep running when the window closes or crashes. Mobile and remote machines are roadmap, not MVP, but must not require an architecture rewrite. T3 Code is built this way.                                                                                                                                                                                                                                                                                                                          |
| 3   | The task is the main entity                                                                | Herdr's rigid spaces are the main pain. A branch is an attribute of a task, not a way to organize.                                                                                                                                                                                                                                                                                                                                                                                                        |
| 4   | Agent status: OSC 7501 first, plugins where it is missing                                  | Claude Code, Codex, pi and Grok report their own status in the terminal stream. OpenCode does not; it needs a plugin.                                                                                                                                                                                                                                                                                                                                                                                     |
| 5   | Terminal and chat are two views of one agent session                                       | Either view can be used, and a session can move between them.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6   | Keyboard: prefix mode, fully configurable                                                  | Matches Herdr/tmux muscle memory (`alt+a` today).                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 7   | UI: React 19 + React Compiler                                                              | Terminal output bypasses the framework in any candidate (xterm.js is written to directly), so the framework only drives statuses, board and chat, which are light. React wins on ecosystem (cmdk, resizable panels, Streamdown for streaming Markdown), on porting code from Orca and T3 Code (both React), and on how well agents write it. Mobile does not force it either way: xterm.js needs a WebView on mobile in every option.                                                                     |
| 7a  | UI primitives: Base UI (`@base-ui/react`, 1.x stable) + cmdk for the command palette       | Base UI covers Dialog, AlertDialog, Select, Combobox, Toast, Menu, Popover, Tabs, ContextMenu, unstyled, with keyboard and focus handling. It has no command-palette primitive; cmdk adds ranking, groups and aliases.                                                                                                                                                                                                                                                                                    |
| 8   | Server: plain TypeScript on Node, no Effect                                                | node-pty is a Node binding; Bun/Deno compatibility is unproven. Effect v4 RPC is marked unstable, adoption reports are mixed, and its model is a large surface for us and for agents.                                                                                                                                                                                                                                                                                                                     |
| 9   | Two channels: typed RPC for control, one binary socket per attached terminal               | Browser WebSocket has no receive backpressure, so terminal streams need their own credit/ack flow control (as in the spike; T3 Code uses 8 chunks / 64 KiB). RPC: oRPC over WebSocket, contract-first (subscriptions as event iterators; works from browser, Electron and React Native). Chosen over tRPC because tRPC derives the client type from the server router, which breaks the rule that clients never import server code; an oRPC contract lives in `packages/protocol` with no implementation. |
| 10  | Server keeps terminal state in `@xterm/headless` and sends a serialized snapshot on attach | Agents are full-screen TUIs; raw-output replay (T3 Code) does not restore them reliably, a VT snapshot does (Orca: `.refs/orca/src/main/daemon/headless-emulator.ts`). The same headless parser hosts the OSC 7501 handler, so status works with no client attached.                                                                                                                                                                                                                                      |
| 11  | Storage: SQLite via `node:sqlite`                                                          | No extra native module next to node-pty. Release Candidate on Node 24; fall back to better-sqlite3 if it bites.                                                                                                                                                                                                                                                                                                                                                                                           |
| 12  | Server restart (update or crash) kills PTYs in MVP; agent sessions resume by id            | We own every agent session id, so after a restart the server relaunches agents with `--resume`/`resume`; shells start fresh. Keeping live PTYs across upgrades is a later step (see Open questions). T3 Code does the same today.                                                                                                                                                                                                                                                                         |

## Architecture

```
 desktop client (Electron, xterm.js)  ─┐
 mobile client (later)                ─┼─ WebSocket ── server (Node)
 client on another machine (later)    ─┘                ├─ tasks, sessions store
                                                         ├─ git worktrees
                                                         ├─ PTY manager (node-pty)
                                                         ├─ agent status ingest
                                                         └─ agent protocol adapters (chat)
```

- **Server** is a separate long-lived process. The desktop app starts it if none is running, and it outlives the window, like Orca's daemon.
- **Terminal streams** go as binary frames with ack-based backpressure (as in the spike: `src/pty-host.cjs`, `src/renderer/index.ts`).
- **Reattach**: the server feeds every PTY into an `@xterm/headless` instance (scrollback ~5k rows, as Orca and T3 Code) and sends a serialized snapshot, then live output. Normal-buffer scrollback and the alt screen are serialized separately (Orca: `.refs/orca/src/main/daemon/terminal-snapshot.ts`).
- **Server lifecycle**: detached process, single-instance lock, PID/endpoint file, versioned handshake so an old client and a new server refuse to talk instead of misbehaving. Orca and T3 Code both hit duplicate-instance and update-skew bugs (`.refs/t3code/docs/architecture/server-updates.md`).
- **One API** for every client. Nothing desktop-only in the protocol, so the mobile client is just another client.
- **Web client** is the same bundle in Electron and in a plain browser served by the server. Electron adds only native shell bits (window, menus, starting the server).
- **Mobile** (roadmap): another client of the same API. The UI framework choice must leave a realistic mobile path (open question).
- **Remote**: a client connects to a server on another machine. This needs auth and a transport beyond loopback; out of MVP, but the protocol must not assume localhost.

### Local trust boundary

The server executes commands for its clients (`terminals.create` takes command, args and env), so a web page on another origin that can reach loopback must not become a client. Each server run generates a random capability (32 bytes, base64url) and publishes it only in `endpoint.json` in its state directory (`0700` directory, `0600` file). Every WebSocket presents it as a subprotocol (a `corral.capability` marker followed by the token), and the single upgrade handler checks it before choosing `/rpc` or a terminal path; a missing or wrong capability gets HTTP 401 and never reaches routing. The token is never put in a URL, so request logs, `Referer` and diagnostics stay clean. `Origin` is not the gate: desktop loads `file://`, browser dev loads another origin, and `Origin: null` is common, while any holder of the capability is trusted.

Delivery: the desktop main process reads the endpoint file and hands `{url, capability}` to the page over a narrow preload IPC bridge, only to the trusted top frame; other frames and popups get nothing. The page URL keeps only the tokenless `?server=`, unexpected navigation is blocked, and ordinary http(s) links are passed to the OS browser instead of loading in the capability-bearing window. Browser/dev mode takes an explicit capability from `#/route?capability=...`, keeps it in `sessionStorage` and removes it from the hash before routing, so reloads and hash navigation work. A page with no capability shows a startup error instead of opening an unauthenticated socket.

What this stops: a hostile page that can reach loopback calling RPC (including `terminals.create`) or attaching terminal streams. What it does not stop: code already running as the same OS user, which can read `endpoint.json`; that code is trusted like the config file. Status reports keep their separate per-session bearer token, and remote authentication/RBAC stays out of MVP (see **Remote** above).

## Domain model

- **Project**: a git repository, added by path.
- **Task**: title, state (active / settled), branch, workspace. Settled means the work is done (T3 Code's "settle"): the task moves to a collapsed shelf, keeps its worktree and branch, and its running sessions are stopped; making it active again resumes the sessions that were running. Automatic settling (pull request merged, inactivity) comes later. The workspace is one of: a new worktree on a new branch (default; branch named from the title, off the project's default branch), a new worktree on an existing branch, or the project's main working tree (no worktree).
  - Worktrees live in the data dir (`~/.local/share/corral/worktrees/<project>/<task>`), not next to the repository, so they never show up in the user's repository directory.
  - Removing a task closes its terminals and removes the worktree it owns, but refuses a worktree with uncommitted or untracked changes unless forced. Branches are never deleted by Corral.
  - Projects and tasks persist in SQLite (`<data dir>/corral.db`); terminals do not (decision 12).
- **Session**: lives in a task. Either a shell, or an agent session `{ agent, agentSessionId, view: terminal | chat }`.
- **Space**: an optional saved grouping or filter over tasks, not a container.
- **Board**: all tasks with their status, navigable from the keyboard.

A task's status comes from its agent sessions (working / blocked / done / error / idle).

### Sessions

- Everything that runs in a task is a session: a shell or an agent (Claude Code, Codex, pi, OpenCode). Sessions persist; terminals do not. A loose terminal outside any task is the only kind that is not a session.
- After a server restart, sessions that were running start again: a shell fresh in the workspace, an agent resumed by its own session id. A session the user stopped, or an agent that exited by itself, stays stopped until started again.
- Agent session ids, checked against `--help` of the versions in the table below:
  - Claude Code: `--session-id <uuid>` at start, `--resume <uuid>` to resume. pi: `--session-id <id>` both ways (creates it if missing). OpenCode: `--session <id>` both ways (creates it if missing).
  - Codex cannot be given an id. Herdr and Orca learn it from a `SessionStart` hook they install in the user's global `~/.codex/hooks.json`. Corral does not touch global agent config in MVP; instead the server finds the new rollout file in `$CODEX_HOME/sessions` whose `session_meta.cwd` is the task's workspace and that started after the spawn (workaround: two Codex sessions started at once in one workspace are ambiguous). Resume: `codex resume <id>`.
- Agents get `CORRAL_SESSION_ID` and `CORRAL_TASK_ID` in their environment, plus `CORRAL_STATUS_URL` and `CORRAL_STATUS_TOKEN` for agents that report status over HTTP.

### Status

- The server's headless terminal parses OSC 7501 and answers its `?` probe (Claude Code and pi only report after the probe). A session's status is its root record; a blocked subagent makes the session blocked.
- OpenCode reports through a plugin derived from Herdr's (v2 plugin API) that POSTs to `CORRAL_STATUS_URL`. Measured on 2.1.4 (isolated HOME): plugins load inside OpenCode's shared background service with the first client's environment, so the server launches `opencode --standalone` (server in the client process) and loads the plugin through `OPENCODE_CONFIG_CONTENT`, which merges with the user's global config and `OPENCODE_CONFIG`; `OPENCODE_CONFIG_DIR` would replace the global config and is not used. If the user already sets `OPENCODE_CONFIG_CONTENT`, the session has no plugin status.
- OpenCode 2.1.4 also sends OSC 7501 itself (whether it reports `blocked` is unverified). Once a launch has delivered an HTTP report, OSC no longer changes that session's status until the next launch (Orca's rule, without Orca's 2-minute takeover when the plugin goes quiet).
- A task's status is the most urgent of its sessions': blocked, error, working, done, idle.
- Board: all active tasks across projects with their status and the agent's message, most urgent first, opened from the keyboard; choosing a task jumps to the session that needs attention.

## Agent status

- **OSC 7501** (Program Status Protocol): parse via `term.parser.registerOscHandler(7501, …)` and answer the `?` probe. Port from Orca, MIT: `.refs/orca/src/shared/program-status/` (`protocol.ts`, `osc-scanner.ts`, `query-responder.ts`, `records.ts`, ~500 lines). Support matrix: `.refs/orca/src/main/agent-hooks/README.md`.
  - Claude Code, pi, Grok: state, blocked reason, message. Codex: state only.
  - Parsing belongs on the server, so status works with no client attached.
- **OpenCode**: plugin that reports session events to the server. Port from Herdr, Apache-2.0: `.refs/herdr/src/integration/assets/opencode/herdr-agent-state.js` (~220 lines).
- **Not now**: Orca's full hook layer (~21k lines) and Herdr's screen-scraping manifests (`.refs/herdr/src/detect/manifests/`). Revisit only for an agent with neither OSC 7501 nor a plugin API.

## Terminal and chat

Verified by research for Claude Code 2.1.310, Codex 0.164.0, pi 1.4.0, OpenCode 2.1.4 (docs and source; nothing run). All four store sessions by id and resume them from both the TUI and the programmatic mode, so switching view = stop one frontend, resume the same id in the other. What survives is the stored history; in-flight turns, pending approvals and streaming state do not.

| Agent       | Session id                                                       | Chat via                     | History for the chat view                                 | Two frontends live at once                                                     |
| ----------- | ---------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Claude Code | we set it: `--session-id UUID`; resume `--resume ID`             | Agent SDK (`options.resume`) | SDK `getSessionMessages()` (transcript JSONL is internal) | no; `claude attach` exists, unexplored                                         |
| Codex       | server assigns it (`thread/start`); learn it from the app-server | app-server                   | app-server history API                                    | yes, through the same app-server; a second process gets a writer-lock conflict |
| pi          | we set it: `--session-id ID`                                     | `--mode rpc`                 | RPC `get_messages`                                        | no; no writer lock, concurrent appends corrupt the file                        |
| OpenCode    | we set it: `--session ID`                                        | its HTTP server              | `GET /session/:id/message`                                | yes, as clients of one server                                                  |

Rules this implies: one writer per agent session at a time, enforced by our server; for Codex and OpenCode the agent's own server is the live session and both views attach to it.

- **Codex, live in both views** (docs + source): our server runs `codex app-server --listen unix:///…/codex.sock`; the chat view is an app-server client, the terminal view is `codex --remote unix:///…/codex.sock resume <thread>`. Tool approvals go to every attached client; the first answer wins and the others get the resolution. The socket transport is documented as experimental.
- **Claude Code, stop-and-resume only**: no supported live attach between the SDK and the TUI. `claude attach` is for its own `--bg` sessions; Remote Control goes through claude.ai and needs a subscription login, so it is out.

## Keyboard

Findings (sourced, see research notes below): browsers keep some chords for themselves, and Electron can capture almost everything.

- Prefix mode: prefix key, then an action key. Default prefix `alt+a`.
- Every binding is configurable in `~/.config/corral/config.toml` (`packages/protocol/src/config.ts`). The server reads and watches the file and pushes the effective config to every client; an invalid entry is dropped with a reported problem, the rest applies. User commands bound to keys (Herdr's `[[keys.command]]` popups) come after MVP.
- Direct chords are reserved for things that must work inside a terminal without the prefix (font size, as now).
- A command palette lists every action with its binding.
- Bindings match `KeyboardEvent.code` (physical key), so they work on the Russian layout; text input uses `key`. Printable and composing keys are never intercepted, so xterm.js IME and dead-key handling keep working.
- **Electron**: the app intercepts in `before-input-event` and has no application menu, so a lone Alt does not reveal a menu bar on Linux.
- **Browser**: Ctrl/Cmd+W/T/N, Ctrl+Shift+T and Ctrl+Tab are browser-owned in Chromium and Safari (Firefox lets some through); a page cannot cancel them. Default bindings avoid them, config validation warns when a user binds one, and a `beforeunload` prompt guards an accidental Ctrl+W in a terminal. Keyboard Lock unlocks them only in Chromium in JS-requested fullscreen; optional, not relied on.

## MVP

1. Server + desktop client, sessions survive closing the window.
2. Projects and tasks; task creates branch + worktree.
3. Terminal sessions in a task: shells and agents (Claude Code, Codex, pi, OpenCode).
4. Agent status: OSC 7501 + OpenCode plugin; board with task statuses.
5. Prefix keymap from a config file; command palette.

Later: chat view and view switching, mobile client, remote servers, orchestration, Markdown/HTML rendering.

## Open questions

- **Mobile shell**: Capacitor (reuse the web client in a WebView) vs Expo with DOM components for the terminal. Either keeps the server API; decide when mobile starts. xterm.js WebGL context loss on mobile needs testing (Orca hit it).
- **Live PTYs across server upgrades** (after MVP). Prior art: Orca keeps a versioned daemon per protocol version and lets old daemons keep their sessions; Herdr hands PTY master fds to the new server over a Unix socket (`SCM_RIGHTS`) and rolls back on failure (`.refs/herdr/src/server/headless/lifecycle.rs`). For us: either a tiny, rarely-changing PTY-holder process separate from the server logic, or Herdr-style fd handoff (Node needs a native helper for that).
