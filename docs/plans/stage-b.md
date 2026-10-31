# Stage B: chat (pi)

Implementation plan for stage B (`design.md`, **Stages**): a chat view of an agent session, first for pi, as a tab of the task next to terminals. Product rules: `design.md` decisions 5, 13–15, **Terminal and chat**; `ux.md` **Target flow** 3–4; `layout.md` **Chat** and **Session tabs** for sizes and placement. Where a brief and `design.md` disagree, `design.md` wins and the brief is corrected.

Starts after stage A is integrated: it builds on the new-task view (A5), the primary session (A3), number keys (A6), status/unseen (A7) and the tab strip (A8). File references assume `main` after stage A; re-check names before starting.

## pi facts this plan relies on

From pi 1.4.0's own docs (`<pi install>/docs/rpc.md`, `rpc-commands.md`, `json.md`, `rpc-extension-ui.md`; find the install with `readlink -f "$(which pi)"`). Re-check against the installed version when a slice starts.

- `pi --mode rpc` is a long-lived child speaking strict JSONL on stdin/stdout; normal CLI options (`--session-id`, `--provider`, `--model`, working directory) still apply. Split records only on LF: Node's `readline` also splits on U+2028/U+2029, which are valid inside JSON strings. Stdout is protocol only; stderr is diagnostics.
- Commands carry an optional `id` echoed in their `response`: `prompt` (with `streamingBehavior: steer` while running), `steer`, `follow_up`, `abort`, `get_state`, `get_messages`, `set_model`, `get_available_models`, `set_thinking_level`, `get_available_thinking_levels`, among others.
- A successful `prompt` response means accepted, not finished. Events: `agent_start`, `agent_end`, `agent_settled` (the run will not continue by itself; `aborted` flag), `message_start`/`message_update`/`message_end` (text, thinking and tool-call deltas; `message_end` is authoritative), `tool_execution_start`/`update`/`end`, `queue_update`, `thinking_level_changed`, compaction and retry events.
- pi has no built-in tool approvals. Extensions ask the user through `extension_ui_request` (`select`, `confirm`, `input`, `editor` block until an `extension_ui_response`; `notify`, `setStatus` and others are fire-and-forget).
- Closing stdin asks pi to shut down in order.
- The RPC mode and the TUI share pi's session store, so `pi --session-id <id>` continues a conversation the RPC mode wrote, and back (research 2026-10-31, high confidence). Two writers at once corrupt the session file: pi has no writer lock.

## Order

```
wave 1:  B0
wave 2:  B1  B3                 B1 needs B0; B3 needs B0
wave 3:  B4  B5                 B4 needs B1, B3; B5 needs B1, B3
final:   B-verify
```

Gates for every slice are stage A's (`plans/stage-a.md`, **Gates for every slice**), with a fake pi that speaks the RPC protocol instead of fake TUIs. No paid model calls.

---

## B0. Chat contract

**Goal.** Corral's own, provider-neutral contract for a chat session: what the server streams and what clients may send (decision 14).

**Where.** `packages/protocol/src/` (a new `chat.ts`, wired into the oRPC contract), `packages/client/src/` (a framework-agnostic chat store that applies snapshot + events, for web now and mobile later).

**Rules.**

- Items, each with a stable id: user message (text; images later), assistant message (text, streaming flag), reasoning (text, streaming), tool call (tool name, arguments, status `running | done | error`, output or result, optional diff), user request (a question the agent waits on: `select | confirm | input | editor`, title, options, timeout), notice (fire-and-forget text), error.
- Session-level state: turn state (`idle | working | settled | aborted | error`), queued steering and follow-up messages, current model and reasoning level, the available models and levels.
- `chat.watch(sessionId)` yields one snapshot, then sequenced events; a client that reconnects with its last sequence number gets the missing events, or a fresh snapshot when they are gone. Actions: `chat.send(text, mode: prompt | steer | follow-up)`, `chat.abort`, `chat.respond(requestId, value)`, `chat.setModel`, `chat.setReasoning`.
- Model it on T3 Code's normalized items (`packages/contracts/src/orchestrationV2.ts` in `../../oss/t3code`, MIT) as an idea, not its schema: no runs, checkpoints, provider refs or subagent threads.
- Clients never see a provider protocol: everything pi-specific stays in the B1 driver.
- The contract carries no transcript persistence: the agent's own session is the conversation (`roadmap.md`, **Decision boundaries**).

**Done when.** Schemas and the client store exist with tests for applying snapshot + events, a sequence gap leading to a resnapshot, and streaming text assembled from deltas; the contract is documented in `design.md` (**Terminal and chat**) in a few lines.

**Depends on.** Nothing.

## B1. pi driver

**Goal.** The server runs a pi session in RPC mode and exposes it through the B0 contract; a session has a view, and chat sessions start, stop, resume and report status like terminal ones.

**Where.** A new server module (e.g. `apps/server/src/chat/` with `pi-driver.ts`), `apps/server/src/sessions/session-service.ts` (launch per view), `packages/protocol/src/rpc.ts` (`Session.view`), `apps/server/src/storage/database.ts` (migration), launch env and profile resolution as for terminal launches.

**Rules.**

- Add `view: terminal | chat` to `Session` (migration: existing sessions are `terminal`). A `chat` session has no terminal; its live frontend is the RPC child.
- Spawn `pi --mode rpc --session-id <id>` with the launch args, profile environment and `CORRAL_*` variables a terminal launch gets, in the task's workspace. Restore after a server restart resumes the same id in the same view.
- Decide, and record the choice in `engineering.md`: a hand-written JSONL client against the documented protocol (recommended: the protocol is short and specified, and a pi npm dependency would pin a pi version apart from the user's installed binary) or pi's exported `RpcClient`.
- Framing per the facts above; read stdout continuously; correlate responses by id; a parse failure or unexpected exit ends the frontend with a visible reason, like a failed terminal launch.
- On every (re)start, load history with `get_messages` and turn it into items, then stream events. The in-memory chat state is the server's; it is rebuilt from pi after a restart, and pending user requests are lost then (record this limit).
- The prompt of a task created in chat view (A3/A5 path) is sent with the `prompt` command once the child is ready, on first start only.
- Status comes from events instead of OSC 7501: `agent_start` → working, a pending dialog request → blocked (`question`), `agent_settled` → done (or idle when aborted), a provider error → error. Settle stops the child (close stdin, then a deadline and a kill); continue restarts it.
- One writer: a session has at most one live frontend by construction; the driver never starts a second process on the same id.

**Done when.** Tests with a fake pi RPC executable cover start with prompt, streaming assembly, tool events, a dialog request answered by the client, abort, crash with a visible reason, restore with history and no resent prompt, and status transitions; the migration test keeps existing sessions as `terminal`.

**Depends on.** B0.

## B2. Session tab strip

Moved to stage A as A8 (`plans/stage-a.md`). B3 renders inside an A8 tab.

## B3. Chat view

**Goal.** A keyboard-first chat tab that renders the B0 stream and sends actions (decision 15).

**Where.** A new `apps/web/src/modules/chat/`, using the B0 client store; dependencies added to `apps/web` per `engineering.md`'s dependency rules.

**Rules.**

- Choose the Markdown engine first (decision 15: Streamdown vs T3 Code's `react-markdown`), with streaming partial Markdown as the deciding case; record the choice in `design.md` decision 15.
- Sizes and styling as `layout.md` **Chat** (46 rem lane, user bubbles, folded tool calls, composer bounds).
- Timeline: virtualized (`@legendapp/list`, as T3 Code), user and assistant messages, reasoning collapsed by default, tool calls as collapsible blocks with arguments and output, code blocks highlighted with Shiki, diffs with `@pierre/diffs` when a tool result carries one (pi's edit tool; check what its result contains). Auto-scroll follows the stream unless the user scrolled up.
- Composer: Enter sends, Shift+Enter inserts a newline; while working, Enter steers and a modifier queues a follow-up (show which); an abort action with a prefix binding (`prefix .` proposed) and in the palette.
- User requests render inline at the end of the timeline with keyboard focus; answering sends `chat.respond`. Notices render as quiet timeline lines.
- Prefix mode keeps working inside the composer (capture phase, as in terminals); the composer owns plain keys.
- Port T3 Code's rendering pieces where they fit (`apps/web/src/components/ChatMarkdown.tsx`, `chat/MarkdownCodeBlock.tsx`, `chat/MessagesTimeline.tsx` in `../../oss/t3code`, MIT; keep the license notice where code is copied), replacing T3-specific link, file and environment hooks. Links to local files are stage C (C5); here they render as plain links.
- Stock kit components and tokens; new structural variants only where `ux.md` allows.

**Done when.** Browser tests render a recorded event stream (streaming text, reasoning, tool call, diff, request), send, steer, follow up, abort and answer by keyboard only; the timeline stays responsive with a long transcript (state the measured size).

**Depends on.** B0 (and A8's tabs).

## B4. View handoff between chat and terminal

**Goal.** `prefix v` moves the current agent session between chat and terminal, continuing the same conversation (decision 5).

**Where.** `session-service.ts`, sessions contract (`sessions.setView`), keymap actions, the tab strip.

**Rules.**

- Handoff stops the live frontend, waits for its process to exit, then starts the other view with resume on the same agent session id; the session keeps its id, label and tab position.
- While the agent is working, the action asks to confirm and aborts the turn first; when idle it proceeds at once. Pending user requests are cancelled with the frontend (state this in the confirmation).
- Only agents with a chat driver offer the action (pi in stage B); others show it disabled with the reason in the palette.
- A handoff whose second start fails leaves the session stopped with the launch error and a way to retry in either view; it never leaves two frontends.

**Done when.** Tests with the fake pi cover idle handoff both ways with history intact, handoff while working (abort, then switch), a failed second start, and that no second process runs on the id; an Electron e2e switches a session chat → terminal → chat.

**Depends on.** B1, B3.

## B5. Model, reasoning and agent settings

**Goal.** The chat shows and changes the model and reasoning level mid-session, the composer can create chat tasks, and agents have the settings T3 Code's provider page covers that Corral lacks.

**Where.** Chat view header and palette actions, `packages/protocol/src/config.ts` (`[tasks] view = "chat"` becomes valid; `[agents.<kind>]`), Settings, the A5 composer.

**Rules.**

- Model and reasoning pickers list what the driver reports (`get_available_models`, `get_available_thinking_levels`) and apply with `chat.setModel`/`chat.setReasoning`; keyboard-reachable, with palette actions.
- `view = "chat"` is accepted where the agent has a chat driver; for other agents the effective view falls back to terminal with a config warning. The composer's view control is enabled.
- `[agents.<kind>]`: `enabled` (default true; disabled agents disappear from pickers) and `command` (an executable path overriding the `PATH` lookup). Launch profiles stay the place for model, provider and environment (`docs/agent-profiles.md`); do not duplicate them.
- Settings shows agents, whether each is found, and which have a chat driver.

**Done when.** Tests cover model and level changes reaching the fake pi, the chat view default per project, a disabled agent hidden from pickers and a custom command used for launch.

**Depends on.** B1, B3.

## B-verify. Whole flow

Independent real-interface verification with a fake pi RPC executable: create a task in chat view from the composer → the prompt arrives once → streaming answer, tool call and diff render → a dialog request is answered by keyboard → steer and abort → change model and reasoning → `prefix v` to terminal, where the fake TUI receives the same session id → back to chat with history → settle, continue → server restart restores the chat with history and no resent prompt. Screenshots at 1920×1080 and 1024×640; report at `.e2e/stage-b/verify/report.md`.

Separately and only with the user's permission (it is a paid call): one smoke run with the real pi to confirm the RPC/TUI handoff on the installed version.

## Not in stage B

- Other agents' chat drivers, git/PR, local file and media links: stage C.
- Images and attachments in the composer.
- Corral-side transcript storage or search across chats.
