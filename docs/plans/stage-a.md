# Stage A: task model on the terminal

Implementation plan for stage A (`design.md`, **Stages**). Product rules live in `design.md` (decisions 3, 5, 16, 17, **Domain model**), `ux.md` (**Target flow**) and `layout.md` (where things sit and how big; every UI slice follows it); this file splits them into slices an implementation agent can take one at a time. Where a brief and `design.md` disagree, `design.md` wins and the brief is corrected.

Each brief: goal, where the code is, rules, done criteria, dependencies. File references were checked on `main` at `f1074eb`; line numbers drift, names do not.

## Order

```
wave 1:  A0  A1  A2  A6  A7     independent, may run in parallel
wave 2:  A3                     needs A2, A6
wave 3:  A4  A8                 A4 needs A0, A1, A3, A6; A8 needs A6, A7
wave 4:  A5                     needs A0, A3, A8
final:   A-verify               needs every slice integrated
```

Conflicts are expected and mechanical: most slices touch `packages/protocol/src/rpc.ts`, and A3, A6 and A7 each append a migration to `MIGRATIONS` in `apps/server/src/storage/database.ts`. Integrate one slice at a time; the next rebases and renumbers its migration.

## Gates for every slice

- `pnpm check` green under the pinned Node (`mise exec -- pnpm check`; Node 22 fails four client tests, see `progress.md`).
- Slices that change the web client: `pnpm test:browser`; slices that change a user-visible flow: `pnpm test:e2e` as well.
- New behavior has tests of observable behavior (`engineering.md`, testing rules). Existing tests change only where the behavior they assert changed on purpose.
- Docs that describe the changed behavior are updated in the same branch: `ux.md` sections marked "Current (until stage A)" are rewritten when the flow they describe is replaced.
- Verification uses fake agent executables and a fake naming CLI. Real agent CLIs are used only for `--help`/`--version` checks; no paid model calls and no writes to the user's global agent config.

---

## A0. Task defaults and per-project settings

**Goal.** The config file carries the defaults the composer and task creation use, with per-project overrides (decision 17), and Settings shows them.

**Where.** `packages/protocol/src/config.ts` (schema, `ClientConfig`, `ConfigState`), `apps/server/src/config/config-file.ts` (parsing, problems), `apps/server/src/config/config-watcher.ts`, `apps/web/src/modules/settings/`.

**Rules.**

- New sections:
  - `[tasks]`: `agent` (an `AgentKind`) or `profile` (a profile id; wins over `agent`), `model`, `workspace` (`main-worktree` | `new-worktree`, default `main-worktree`), `worktree-root` (absolute or `~`-relative; default `<data dir>/worktrees`), `branch-prefix` (default empty), `slug-mode` (`title` | `generated`, default `title`), `view` (only `terminal` is valid in stage A; `chat` is reported as a problem until stage B).
  - `[naming]`: `profile` or `agent` + `model`, `timeout-seconds` (default 8). Empty means no generation (decision 16).
  - `[projects."<absolute repository path>"]`: the same keys as `[tasks]`, overriding them for that project. Unknown keys and invalid values are problems that drop only that entry, as today.
- Resolution order: built-in default → `[tasks]` → project override. Expose the effective values per project to clients with where each came from (`default` | `global` | `project`), so the composer and Settings need no resolution logic of their own. One resolution function on the server; clients render its output.
- Settings (read-only, `ux.md`) shows the effective global values, each project's overrides, and a note when `[naming]` is empty.

**Done when.** Config tests cover each key's valid and invalid forms, the resolution order and a project override of a single key; Settings shows effective values and their source; an invalid entry drops only itself.

**Depends on.** Nothing.

## A1. Readable worktree paths and branch prefix

**Goal.** New worktrees live at `<worktree root>/<repo>/<slug>` and new branches are `<branch prefix><slug>` (`design.md`, **Domain model → Task**).

**Where.** `apps/server/src/tasks/task-service.ts` (`#freeWorktreePath`, `#worktreesDir`), `apps/server/src/tasks/worktree-plan.ts`, `apps/server/src/git/names.ts`.

**Rules.**

- `<repo>` is `directoryName(project.name)`; the short project id is dropped. Two projects with the same directory name share `<root>/<repo>/`; slugs there stay unique through the existing `uniqueName` (`-2`, `-3`). Record this trade-off in `design.md` next to the worktree path.
- The slug is derived from the title (today's behavior) until A4 supplies a generated one; keep the derivation in one function A4 can feed.
- Root and prefix come from A0's effective settings for the project. If A0 is not integrated yet, read them through a small interface with the current defaults, so A0 only wires the source.
- Existing tasks keep their stored `workspacePath`; nothing moves. Removing an old task still removes its worktree.

**Done when.** Tests show the new path and branch shape, a collision suffix, a custom root and a prefix, and that removing a task created under the old layout still works.

**Depends on.** Nothing (A0 only for the settings source).

## A2. Initial prompt on agent start

**Goal.** An agent session can start with a prompt that the agent's TUI begins working on, while staying interactive.

**Where.** `apps/server/src/agents/agent-adapter.ts` and the four adapters (`claude.ts`, `codex.ts`, `pi.ts`, `opencode.ts`), `apps/server/src/sessions/session-service.ts` (`start`, `#launch`).

**Rules.**

- Add `promptArgs(prompt: string): string[]` to `AgentAdapter`. Observed `--help` on this machine (claude 2.1.316, codex 0.166.0, pi 1.4.0, opencode 2.2.5): claude and codex take a positional prompt, pi takes `[--] [messages...]`, opencode takes `--prompt <text>`. Re-check against the installed versions and record the versions in the adapter comments.
- A prompt starting with `-` must not be read as a flag (use `--` where the CLI supports it). pi reads `@path` arguments as files: establish what a prompt starting with `@` does and keep it a message; if that is impossible, document the limit in the adapter and in `design.md` (**Sessions**).
- The prompt is passed on the first start only. Resume, restart, settle → continue and server-restart restore never pass it again, or the agent would redo the work. Claude's `hasConversation` fallback (start again under the same id when no transcript exists) must not resend it either; a start that had a prompt has a transcript.
- The prompt goes through argv as one argument, never through a shell.

**Done when.** Adapter tests assert the argument lists, including a prompt with a leading `-`, quotes and newlines; a session-service test with a fake agent shows the prompt on start and its absence on restart and restore.

**Depends on.** Nothing.

## A3. Task from a prompt

**Goal.** Creating a task takes a prompt and an agent choice, starts the primary agent session with that prompt, and no longer starts a shell (`design.md`, **Domain model → Task → Creation**).

**Where.** `packages/protocol/src/rpc.ts` (`CreateTaskInput`, `Task`), `apps/server/src/tasks/task-service.ts`, `apps/server/src/tasks/task-store.ts`, `apps/server/src/sessions/session-service.ts`, `apps/server/src/storage/database.ts`, `apps/web/src/modules/workspace/use-workspace.ts` (`createTask` starts a shell today), the current new-task dialog until A5 replaces it.

**Rules.**

- `CreateTaskInput` gains `prompt` (optional, trimmed) and `agent` (optional: `{ kind, profileId?, expectedProfileRevision?, model? }`, the shape session start already takes). A title is required only when there is neither a prompt nor an issue source.
- `Task` gains `prompt` (nullable) and `primarySessionId` (nullable); it sets `titleSource`, which A6 introduced.
- Seed title: first non-empty line of the prompt, whitespace collapsed, cut at a word boundary to at most 60 characters with `…`. An explicit title wins and is `user`; an issue title is `user` too (the user saw and accepted it). A task with neither prompt nor title is not possible through the composer; through the RPC it is rejected as today.
- With an `agent`, `create` starts that session with the prompt (A2) and records it as primary. A launch failure keeps the task and the session in its failed state with the launch error, so the user can restart it; it does not roll back the task.
- The client stops starting a shell after creation. A task created without an agent is empty until the user adds a session.
- Migration adds the two columns; existing tasks get `NULL` in both.

**Done when.** RPC tests cover prompt + agent, prompt-only rejection rules, seed derivation, launch failure keeping the task, and the migration from the previous schema with data; the existing new-task flow still works (with no shell started), proven by the updated e2e.

**Depends on.** A2, A6.

## A4. Title and slug generation

**Goal.** A task created from a prompt gets a generated title, and in `generated` slug mode a generated branch and worktree name, without a random name ever reaching disk (decision 16).

**Where.** A new server module (e.g. `apps/server/src/naming/`), `task-service.ts` (`#create`), the slug function from A1, A0's `[naming]` settings, launch-profile resolution in `apps/server/src/agents/launch-env.ts`.

**Rules.**

- Generation runs only when the task has a prompt, no explicit title, and `[naming]` is configured. Otherwise the seed title stays.
- Run the configured agent in its non-interactive mode with no session saved and no tools, in a temporary working directory (not the repository), with the profile's environment references resolved as for a launch. Candidate flags observed on this machine: claude `-p --no-session-persistence --tools ""`, pi `-p --no-session --no-tools`, codex `exec --ephemeral --skip-git-repo-check`, opencode `run` (whether it saves a session is unverified; check, and if it cannot be made ephemeral, leave opencode out of `[naming]` with a config problem). Verify each against the installed `--help`.
- One prompt template asks for a JSON object `{ "title": …, "branch": …, "worktree": … }` (branch/worktree only in `generated` mode), passing at most 8000 characters of the prompt and the project name. Title: 3–8 words, under 40 characters, naming the outcome, not copying the request (T3 Code's rule).
- Sanitize: title single line, 1–60 characters; slugs lowercase ASCII letters, digits and `-`, at most 40 characters, valid under `git check-ref-format` with the prefix; anything invalid falls back to the slug derived from the title (or the seed title). Parse the first JSON object in stdout; anything else is a failure.
- Timeout from `[naming]`; on timeout, non-zero exit, missing executable or bad output, log the reason and keep the seed. No retries in stage A.
- Main working tree: `create` returns at once; the title arrives through the task watch. Worktree: `create` waits for naming (bounded by the timeout), then creates the branch and worktree from the result. A title the user renamed in the meantime (`titleSource = user`) is never overwritten.
- No secret or prompt text in logs beyond the failure reason.

**Done when.** Tests with a fake naming CLI cover success in both slug modes, garbage output, an invalid branch name, timeout, a missing executable, the worktree wait, and a rename racing the generation; nothing random appears in a created worktree path.

**Depends on.** A0, A1, A3, A6.

## A5. New-task view

**Goal.** `prefix t` shows a prompt-first new-task view in the main area that replaces the new-task form dialog (`ux.md`, **Target flow** 1–2; `layout.md`, **New task view** and **Empty states**).

**Where.** `apps/web/src/modules/tasks/new-task-dialog.tsx` (replaced by a main-area view), `issue-import.tsx`, `apps/web/src/modules/sessions/agent-picker.tsx` and `launch-choice.ts` (reuse the agent/profile/model choice), `apps/web/src/modules/workspace/use-workspace.ts`, the A8 shell.

**Rules.**

- Layout, sizes, placeholder and picker row exactly as `layout.md` **New task view**; it is also what the main area shows when no task is selected.
- Prompt focused on open; Enter submits, Shift+Enter inserts a newline; Escape returns to the previously selected task. Project, agent or profile, model and workspace are prefilled from A0's effective settings for the chosen project; changing the project re-applies that project's defaults to fields the user has not touched.
- Optional title and "From issue…" expand in place. Branch choices of today's form (new branch, existing branch, main working tree) live in the workspace picker.
- Issue import fills the prompt with the issue's title and URL and keeps the source snapshot; the existing guards (pending, cancel, project switch) carry over.
- While `create` waits (worktree mode, A4), the button reads "Creating…" and the input stays; errors stay in the view with `role="alert"`, input preserved (`ux.md`, **Focus, keyboard and errors**).
- Stock kit components only (`ux.md`, `ui-kit.md`); the UI-boundary gates must stay green.

**Done when.** Browser tests cover keyboard-only creation, defaults per project, issue import into the prompt, Escape back to the previous task and error preservation; an Electron e2e creates a task from a prompt and sees the fake agent receive it.

**Depends on.** A0, A3, A8 (A4 optional: without it the seed title shows).

## A6. Rename a task; number keys for sessions

**Goal.** The user can rename a task, and switch sessions in the current task by number.

**Where.** `packages/protocol/src/rpc.ts` (tasks contract), `task-service.ts`, `task-store.ts`, `database.ts`, `apps/web/src/modules/keymap/actions.ts`, `packages/protocol/src/config.ts` (`ActionId`, `DEFAULT_BINDINGS`), the rename dialog in `apps/web/src/modules/workspace/`.

**Rules.**

- `Task` gains `titleSource` (`seed` | `generated` | `user`); the migration sets `user` for existing tasks. A3 and A4 write the other values.
- `tasks.rename(id, title)` sets the title and `titleSource = user`. Branch and worktree are untouched.
- Action `rename-task`, default `prefix e`; session rename keeps `prefix shift+r`. Actions `session-1` … `session-9`, defaults `prefix 1` … `prefix 9`, select the n-th session of the current task in sidebar order. All appear in the palette.
- Reuse the existing rename dialog behavior (focus, opener return, error preservation).

**Done when.** RPC and store tests for rename; browser test renames a task by keyboard and switches sessions by number; the palette lists the new actions.

**Depends on.** Nothing.

## A7. Sidebar modes and unseen completion

**Goal.** The sidebar lists tasks flat by status or grouped by project, and a finished task stays marked until opened (`ux.md`, **Target flow** 5).

**Where.** `packages/client/src/workspace-tree.ts`, `packages/client/src/agent-status.ts` (`taskStatus`, `compareStatuses`), `packages/client/src/board.ts`, `apps/web/src/modules/workspace/sidebar.tsx`, tasks contract and store for `seenAt`.

**Rules.**

- Flat mode: active tasks of all projects ordered by status (needs approval or input → error → working → completed and unseen → idle), then recency; each row shows its project. Settled tasks stay in a collapsed shelf. Project mode is today's tree.
- Toggle action `sidebar-mode`, default `prefix l`; the mode is a device preference kept in client storage.
- "Completed and unseen": the task's status is `done` with an update newer than the task's `seenAt`. `seenAt` is stored on the server (`tasks.markSeen`) so every client agrees (decision 14's reasoning applies). The client marks a task seen when it becomes the selected task and when a status changes while it is selected.
- Status stays a named state plus a distinct glyph (`ux.md`); unseen gets its own glyph or label, not color alone.
- Rows, sections and their content follow `layout.md` **Sidebar** (two-line rows, Needs you / Working / Done / Settled in flat mode). Until A8 removes them, sessions keep rendering under the selected task.
- The board stays as is.

**Done when.** Client tests for flat ordering and unseen derivation; browser test toggles the mode and clears unseen by opening the task; `seenAt` survives a server restart.

**Depends on.** Nothing.

## A8. Workspace shell

**Goal.** The main area shows one task with a header and its sessions as tabs, the sidebar lists tasks only, and the shell matches `layout.md` (**Shell**, **Sidebar** header and footer, **Task header**, **Session tabs**, **Terminal**, **Empty states**, **Status visuals**). This was stage B's B2; it moved here because the revised layout needs it before chat.

**Where.** `apps/web/src/modules/workspace/` (`workspace-screen.tsx`, `sidebar.tsx`, `use-workspace.ts`), `apps/web/src/modules/terminal/terminal-view.tsx`, `apps/web/src/modules/status/`, `apps/web/src/common/ui/` (stock Tabs; new named variants only where `ui-kit.md` allows), the theme CSS for the three status tokens, `packages/protocol/src/config.ts` (action `toggle-sidebar`, default `prefix \`).

**Rules.**

- Sidebar: replace the icon toolbar with the search button and new-task button; footer with the prefix indicator (armed state visible), connection state when not connected, settings. Resizable 208–420 px, default 264, kept per device; `prefix \` hides it.
- Sessions leave the sidebar and become tabs in the main area; loose terminals move to the Scratch section. Tab content, sizes and overflow as in `layout.md`; `prefix 1`–`9`, `prefix n`/`p` and clicks select tabs; "+" offers shell and agent.
- Task header with title, `project › branch`, status, agent/model badge, settle and overflow actions.
- Terminal gets 8 px padding with the main-area background; xterm resizes to the padded box.
- Empty states: no project, task without sessions. (No-task-selected becomes the new-task view in A5; until then it keeps today's behavior.)
- Status colors: add `--status-working`, `--status-attention`, `--status-done` for dark and light; record the change as a permitted adaptation in `ui-kit.md`. Glyph and word stay.
- Focus rules stay (`ux.md`): clicking navigation and tabs does not steal terminal focus; dialogs return focus.
- Update `ux.md` **Layout and navigation** to describe the shell as current and drop the "until stage A" wording there.

**Done when.** Browser tests: tabs switch by key and click with terminal focus kept, sidebar resize/hide persists, prefix pill shows while armed, header shows task facts, empty states render; the UI-boundary and class gates pass; Electron e2e with two sessions in one task; screenshots at 1920×1080 and 1024×640 under `.e2e/stage-a/a8/` compared against `layout.md`.

**Depends on.** A6, A7.

## A-verify. Whole flow

Independent real-interface verification after every slice is integrated: rebuilt web in a browser and built Electron, real server, SQLite, PTY and git, fake agents and a fake naming CLI.

Scenario: empty main area shows the new-task view → `prefix t` → prompt → task appears with the seed title, then the generated one → the fake agent received the prompt → `prefix c` adds a shell → `prefix 1`/`2` switch → `prefix e` renames → worktree mode yields a readable branch and path with no random part → flat sidebar shows the task by status and clears unseen on open → settle and continue → server restart resumes the agent without resending the prompt. Screenshots at 1920×1080 and 1024×640, checked against `layout.md`. Report under `.e2e/stage-a/verify/`.

## Not in stage A

- Naming a task created without a prompt from the agent's first message: needs reading agent history, which the stage B drivers do anyway.
- Pinned tasks; any change to the board.
- A repository-committed settings file (decision 17).
