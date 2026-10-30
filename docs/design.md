# Design

A keyboard-first workspace for running coding agents, for people who live in the terminal.
Replaces Herdr for its author; Orca and T3 Code (`.refs/`) are references, not bases.

## Decisions

| #   | Decision                                                                                   | Why                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Terminal engine: xterm.js + WebGL                                                          | The spike held ~60 fps with 8 agent panes and under flood. libghostty-vt stays behind `PLAYTEST_TERM=ghostty`; it did not win (README, "Findings").                                                                                                                                                                                                                                                                                   |
| 2   | Client/server split from day one; one web client for Electron and the browser              | Agents keep running when the window closes or crashes. Mobile and remote machines are roadmap, not MVP, but must not require an architecture rewrite. T3 Code is built this way.                                                                                                                                                                                                                                                      |
| 3   | The task is the main entity                                                                | Herdr's rigid spaces are the main pain. A branch is an attribute of a task, not a way to organize.                                                                                                                                                                                                                                                                                                                                    |
| 4   | Agent status: OSC 7501 first, plugins where it is missing                                  | Claude Code, Codex, pi and Grok report their own status in the terminal stream. OpenCode does not; it needs a plugin.                                                                                                                                                                                                                                                                                                                 |
| 5   | Terminal and chat are two views of one agent session                                       | Either view can be used, and a session can move between them.                                                                                                                                                                                                                                                                                                                                                                         |
| 6   | Keyboard: prefix mode, fully configurable                                                  | Matches Herdr/tmux muscle memory (`alt+a` today).                                                                                                                                                                                                                                                                                                                                                                                     |
| 7   | UI: React 19 + React Compiler                                                              | Terminal output bypasses the framework in any candidate (xterm.js is written to directly), so the framework only drives statuses, board and chat, which are light. React wins on ecosystem (cmdk, resizable panels, Streamdown for streaming Markdown), on porting code from Orca and T3 Code (both React), and on how well agents write it. Mobile does not force it either way: xterm.js needs a WebView on mobile in every option. |
| 7a  | UI primitives: Base UI (`@base-ui/react`, 1.x stable) + cmdk for the command palette       | Base UI covers Dialog, AlertDialog, Select, Combobox, Toast, Menu, Popover, Tabs, ContextMenu, unstyled, with keyboard and focus handling. It has no command-palette primitive; cmdk adds ranking, groups and aliases.                                                                                                                                                                                                                |
| 8   | Server: plain TypeScript on Node, no Effect                                                | node-pty is a Node binding; Bun/Deno compatibility is unproven. Effect v4 RPC is marked unstable, adoption reports are mixed, and its model is a large surface for us and for agents.                                                                                                                                                                                                                                                 |
| 9   | Two channels: typed RPC for control, a separate binary socket for terminal streams         | Browser WebSocket has no receive backpressure, so terminal streams need their own credit/ack flow control (as in the spike; T3 Code uses 8 chunks / 64 KiB). RPC: tRPC v11 over WebSocket (subscriptions, works from browser, Electron and React Native).                                                                                                                                                                             |
| 10  | Server keeps terminal state in `@xterm/headless` and sends a serialized snapshot on attach | Agents are full-screen TUIs; raw-output replay (T3 Code) does not restore them reliably, a VT snapshot does (Orca: `.refs/orca/src/main/daemon/headless-emulator.ts`). The same headless parser hosts the OSC 7501 handler, so status works with no client attached.                                                                                                                                                                  |
| 11  | Storage: SQLite via `node:sqlite`                                                          | No extra native module next to node-pty. Release Candidate on Node 24; fall back to better-sqlite3 if it bites.                                                                                                                                                                                                                                                                                                                       |
| 12  | Server restart (update or crash) kills PTYs in MVP; agent sessions resume by id            | We own every agent session id, so after a restart the server relaunches agents with `--resume`/`resume`; shells start fresh. Keeping live PTYs across upgrades is a later step (see Open questions). T3 Code does the same today.                                                                                                                                                                                                     |

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

## Domain model

- **Project**: a git repository.
- **Task**: goal (text), status, branch, worktree. Creating a task creates the branch and worktree; picking an existing branch is an option.
- **Session**: lives in a task. Either a shell, or an agent session `{ agent, agentSessionId, view: terminal | chat }`.
- **Space**: an optional saved grouping or filter over tasks, not a container.
- **Board**: all tasks with their status, navigable from the keyboard.

A task's status comes from its agent sessions (working / blocked / done / error / idle).

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
- Every binding is configurable in a config file, including user commands bound to keys (Herdr's `[[keys.command]]` popups are the reference).
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
