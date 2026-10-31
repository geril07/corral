# Stage C: more agents, git and links

Plan for stage C (`design.md`, **Stages**). Coarser than stages A and B on purpose: the pi driver (B1) fixes the shape of the driver interface, and the briefs below are refined against it before work starts. The orchestrator that starts stage C first rewrites each brief here against the integrated code, as `plans/stage-a.md` is written, then runs the slices.

Rules: `design.md` decisions 5, 13–15, **Terminal and chat**; `ux.md`; `plans/layout.md` for where things sit. Gates: `plans/stage-a.md`, **Gates for every slice**. No paid model calls and no writes to real remotes in tests or verification.

## Order

```
wave 1:  C0                     driver interface extracted from B1
wave 2:  C1  C4  C5             C1 needs C0; C4 and C5 independent of drivers
wave 3:  C2  C6                 C2 needs C0 (after C1 for lessons); C6 needs C4
wave 4:  C3                     needs C0; last because of Codex risk
final:   C-verify
```

## C0. Driver interface

**Goal.** One server-side interface every chat driver implements, extracted from the pi driver rather than designed ahead of it.

- What a driver provides: start/resume on an agent session id with launch choices, history load into B0 items, event stream, send (prompt, steer, follow-up where supported), abort, user-request answers, model/reasoning lists and changes, status mapping, orderly stop.
- Capabilities a driver declares, used by the UI to enable controls: steer, follow-up, approvals, model switch, reasoning levels, live terminal next to chat (`both-live` | `view-only-terminal` | `handoff-only`).
- pi moves onto it with no behavior change (its B tests stay green).

**Done when.** The interface and capability flags exist, pi implements them, and `design.md` decision 13 names the file.

## C1. OpenCode driver

**Goal.** Chat for OpenCode, with the terminal live at the same time.

- Facts to re-check on the installed version (2.2.5 observed): `opencode serve` (v2 API with SSE events, `--port`, `--hostname`, `--stdio`), the TUI's `--server <url>` and `--session <id>`, `--standalone`. The server owns the session; chat is an API client, the terminal view runs the TUI against the same server.
- Corral starts one OpenCode server per task workspace (or per session; decide by how the API scopes directories), on a loopback port or `--stdio`, and stops it with the last session using it.
- Status: from the event stream, replacing the plugin path for chat sessions; terminal-only OpenCode sessions keep the plugin (`design.md`, **Status**).
- Approvals: OpenCode's permission requests become B0 user requests; answers from either frontend resolve them once.
- Both views live: switching view is only switching tabs, no handoff; `prefix v` opens the other view next to the current one.

**Done when.** Fake-server tests cover streaming, a permission request answered from chat, both frontends attached, server lifecycle with the last session; real `--help` checks recorded.

## C2. Claude Code driver

**Goal.** Chat for Claude Code through the Claude Agent SDK, stop-and-resume handoff with the TUI.

- `@anthropic-ai/claude-agent-sdk` (0.3.316 observed on npm) as a server dependency; record it in `engineering.md`. Use `resume`/`sessionId` options with Corral's agent session id, so `claude --resume <id>` continues the conversation.
- Verify the SDK uses the user's installed `claude` binary and login, not a bundled one with separate credentials; if it does not, record the gap and stop this slice as an open decision (no new paid account, `roadmap.md`).
- Permissions: the SDK's permission callback becomes a B0 user request; reasoning effort and model through query options.
- History for the chat view after a restart: SDK session messages; the TUI transcript format stays internal (`design.md`, **Terminal and chat**).

**Done when.** Tests with a stubbed SDK cover start, resume, permission round trip, interrupt and handoff to a fake TUI on the same id; one real handoff smoke run only with the user's permission.

## C3. Codex driver

**Goal.** Chat for Codex through the app-server, if its stability allows.

- First resolve the open contradiction in `design.md` (**Terminal and chat**): whether `codex --remote` against Corral's app-server can write while chat is attached, or is view-only. Record the result there.
- The app-server is officially experimental: pin the tested Codex version in the driver, check the version at launch and refuse chat (terminal stays available) on an untested one, with the reason visible.
- Thread id is server-assigned (`thread/start`); store it as the agent session id, replacing rollout-file discovery for chat sessions.

**Done when.** Contradiction resolved and documented; fake app-server tests cover thread start/resume, turn streaming, approval, interrupt; version gate tested.

## C4. Diff and changes per task

**Goal.** See what a task changed without leaving Corral.

- A **Changes** tab kind in the task's tab strip (`plans/layout.md`): files changed in the task's workspace against its base (worktree: merge base with the base branch; main working tree: `HEAD` plus uncommitted), with per-file diffs rendered by the B3 diff component.
- Header shows `+added −removed` for the task; the sidebar row shows a compact count only when non-zero.
- Read-only in this slice. Refresh on file-system change in the workspace, debounced.

**Done when.** Tests on a real temporary repository cover worktree and main-tree tasks, renames and binary files; browser test opens the tab by key.

## C5. Local links in chat

**Goal.** Paths and URLs in chat open usefully, like Ovis does (the user's reference).

- Detect absolute paths, workspace-relative paths (`file.ts:12`) and URLs in assistant text and tool output.
- Images and video inside the workspace or temp dirs preview inline (bounded size), opened full in a lightbox; other files open in the user's editor (`[editor] command` in config, default `$VISUAL`/`$EDITOR` in a new Corral shell tab for terminal editors, or the OS opener); URLs go to the OS browser (desktop) or a new tab (browser).
- The server serves file bytes only for paths inside the task workspace or explicitly allowed roots, through the authenticated channel (`design.md`, **Local trust boundary**); never an arbitrary path.

**Done when.** Tests for detection, the path allow-list (a path outside is refused), preview of an image and a video, editor launch with a fake editor.

## C6. Commit and pull request

**Goal.** Finish a task from Corral: commit, push, open a PR/MR, see its state on the task.

- From the Changes tab: stage all or selected files, commit with a message (optional generated message through `[naming]`'s agent, same rules as title generation), push the branch, create a PR/MR through the user's `gh`/`glab` (as issue import does).
- The task stores the linked PR/MR; the header and sidebar row show its state (open, draft, merged, closed) and checks summary, refreshed on focus and every few minutes.
- Merged PR → offer to settle the task (not automatic in this slice).
- Every remote write is an explicit user action with a confirmation that names the remote and branch. Verification uses a local bare repository and fake `gh`/`glab`; nothing reaches a real host.

**Done when.** Tests with a bare remote and fake CLIs cover commit, push, PR creation, state refresh and the settle offer.

## C-verify

Independent verification of each driver's chat and its view behavior (OpenCode both live, Claude and pi handoff, Codex per C3's outcome), Changes tab, links and the commit/PR flow against fakes. Report at `.e2e/stage-c/verify/report.md`. Real-agent smoke runs only with the user's permission.

## Not in stage C

Mobile client, remote servers, orchestration, Corral-side transcript search, images in the composer.
