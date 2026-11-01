# Layout

Where things sit, how big they are and what each surface shows. Written on 2026-11-01 as a clean-slate revision: the user found the shipped screens unclear and delegated these taste decisions, to polish after they are built. Behavior: `design.md`; interaction rules: `ux.md`; kit rules: `ui-kit.md`. Numbers come from T3 Code (`../../oss/t3code/apps/web`) and Orca (`../../oss/orca/src/renderer`) where noted; both are MIT.

Every choice the user may want to revisit is collected in **Review later** at the end.

## What was wrong

Observed on the stage-0 screenshots (`.e2e/shadcn/1024-workspace.png`, `.e2e/final-combined/screenshots/`):

- A row of seven unlabeled icons tops the sidebar; nothing says which is "new task".
- The main area has no header: nothing names the task, its branch or its status.
- A three-level tree (project → task → session) spends the sidebar's width on indentation; the task title truncates to "Kit migratio…" beside a truncated branch.
- The terminal touches the window edges.
- New task is a tall form dialog; the work starts after six fields.

The revision: the sidebar lists tasks, the main area shows one task with a header and its sessions as tabs, and a new task is a prompt in the main area.

## Shell

```
┌──────────────┬───────────────────────────────────────────────┐
│ sidebar      │ task header                            40 px  │
│ 264 px       ├───────────────────────────────────────────────┤
│              │ session tabs                           32 px  │
│ tasks        ├───────────────────────────────────────────────┤
│              │                                               │
│              │ terminal │ chat │ changes (stage C)           │
│              │                                               │
│ footer 36 px │                                               │
└──────────────┴───────────────────────────────────────────────┘
```

- Two columns; no title bar of our own and no global status bar (the sidebar footer carries the little status there is).
- **Sidebar**: default 264 px (T3 256, Orca 280), resizable 208–420 px by dragging its edge, width kept per device; double-click on the edge resets it. `prefix \` hides and shows it (width 0, main area takes everything). Below 1180 px window width it starts at 232 px.
- **Main area** minimum 640 px (T3's reserve). A right panel is not part of stages A–C; diff is a tab (`plans/stage-c.md`, C4).

## Sidebar

**Header (44 px)**: a full-width "Search tasks" button with its key hint (`prefix f`) and a "New task" icon button (`prefix t`) beside it. Nothing else; add project, board and settings live in the palette, the footer and the project-mode group headers.

**Task rows** (two lines, 52 px; T3's 78 px rows are too tall for 5–10 tasks on a laptop, Orca's cards ~44–56 px):

- Line 1: status glyph (12 px), title (`text-sm`, truncates), right slot: relative time ("4m"), or the status word when the task needs the user ("needs input", "error").
- Line 2 (`text-xs`, muted): in flat mode the project name; then the branch only when the task has its own worktree; then the primary agent's name. Stage C appends `+12 −3` and a PR state when present.
- Unseen completion: title in `font-semibold` plus a 6 px dot before the time. Selected: stock `secondary` background.
- Sessions are not listed in the sidebar any more; they are tabs. A task with more than one session shows a small count on line 2.

**Flat mode** (default): sections with a header and count: **Needs you** (blocked or error), **Working**, **Done** (done or idle, newest first), **Settled** (collapsed). Empty sections are hidden.
**Project mode**: one group per project (header: project name, its task count, a "new task here" icon on hover/focus), tasks inside by creation order, a collapsed Settled group per project.
**Scratch**: loose terminals outside any task, one-line rows at the bottom, only when some exist.

**Footer (36 px)**: connection state as a dot plus word only when not connected; the prefix indicator, which shows `alt+a` muted and turns into a highlighted "prefix…" pill while the prefix is armed (the one piece of feedback a prefix-keyboard app must give); Settings icon.

## Task header (40 px)

- Left: title (`text-sm font-medium`, truncates; `prefix e` renames in place), then muted `project › branch` (branch only for worktree tasks; click copies the workspace path).
- Right: status word with glyph, the primary agent and model as a muted badge, then icon actions: settle (`prefix d`) and an overflow menu (rename, remove, open source issue, copy path). Stage C adds `+12 −3` and the PR badge before the status.
- No header for the new-task view or the empty state.

## Session tabs (32 px)

- One tab per session of the current task, in creation order. A tab: number hint (`1`–`9`, muted, `text-xs`), agent or shell icon (14 px) with the status glyph replacing it while working/blocked, label (session label or natural name: "pi", "shell 2"), close on hover/focus only.
- Chat and terminal tabs look the same apart from a small chat glyph; `prefix v` (stage B) swaps one in place. For an agent whose driver keeps both views live (OpenCode, stage C) it opens the other frontend beside the running one instead: the tab, its number and its place stay, and the stored view says which frontend the main area shows, so the strip never holds two tabs for one session.
- A trailing "+" opens a menu: shell, agent…, chat… (stage B); same as `prefix c` / `prefix s`.
- Tabs take their content width up to 200 px, then truncate; overflow scrolls horizontally with the selected tab kept in view (Orca's model, no fixed width).

## Terminal

- Padding 8 px on every side inside the tab area (Orca defaults to 4 px; 8 px reads as intentional without wasting rows). Background is the same token as the main area, so the padding does not show as a frame.
- Font stays 14 px mono, as today (`ux.md`, **Known limits**).

## Chat (stage B)

- Content lane 46 rem, centered (T3 and Orca both use exactly this).
- User messages right-aligned in a muted bubble, max 80% of the lane, stock radius; assistant text unboxed, full lane width.
- Reasoning: one muted line "Thinking…" / "Thought for 12s", expands in place.
- Tool calls: one line each (`text-sm`, glyph, tool name, short argument, duration, status), expandable; expanded output monospace, max 16 rem tall with its own scroll (T3: `max-h-64`). Consecutive finished tool calls fold into "6 tool calls" until expanded. Diffs render expanded up to 20 lines, then fold.
- Composer: at the bottom of the lane, overlaying the timeline's end; 2 lines minimum, grows to 13 rem, then scrolls (T3: `max-h-52`). One control row below the text: model and reasoning pickers on the left, queue/steer hint and send/abort on the right. Placeholder: "Ask pi…" (agent name).
- A user request (a question the agent waits on) renders as the last timeline item with focus, above the composer.

## Changes (stage C)

- A `Changes` tab per task sits in the session tab strip after the task's sessions. It has no session behind it: no number hint, no status glyph, and selecting it does not change which session is current.
- Full main-area width with the Terminal's 8 px padding, not the 46 rem chat lane: diffs are wide and get horizontal scroll rather than wrapping.
- A summary row at the top ("12 files, +340 −87", `text-sm`, muted), then file rows 28 px high: status letter (`M`/`A`/`D`/`R`), path in mono 13 px truncated from the left, `+N −M` right-aligned. Changed files sort by path; a renamed file shows `old → new`.
- The diff pane under the list: unified hunks, muted hunk headers, monospace 13 px on a 20 px line height, unchanged regions folded with "Show N more lines". Binary files show one row ("Binary file, 12 KB") and no diff. At 1024×640 the list collapses to the top third and the selected file's diff takes the rest.
- The task header shows `+N −M` right-aligned next to the status when non-zero; the sidebar row shows the same compact numbers only when non-zero.
- Read-only in C4, refreshed with a debounce when the workspace changes: loading shows skeleton rows, a clean tree shows "No changes yet". C6 adds staging and commit controls inside this tab, below the summary row.

## New task view

The composer is a view in the main area, not a dialog (T3's draft thread; Orca uses a dialog and its staged form is what the user disliked in Corral's).

- `prefix t` (or the sidebar button, or a project group's "+") shows it in the main area; Escape returns to the previously selected task.
- Centered column 46 rem wide, vertically at about a third of the height. Prompt text area first and focused: 4 lines minimum, grows to 50% of the height. Placeholder: "What should the agent do?".
- One row of compact pickers under it, each a stock combobox-trigger button showing its value: project, agent · model, workspace ("main tree" / "new worktree" / branch name), view (stage B). A muted line under the row shows where the defaults come from when they are a project override ("defaults from project settings").
- "Title (optional)" and "From issue…" are text buttons under the pickers; they expand fields in place.
- Enter creates; Shift+Enter is a newline. While a worktree waits for naming, the button reads "Creating…" and the input stays.

## Empty states

- **No project**: centered, 32 rem column: one line "Add a repository to start", an inline path field with its Add button, a muted hint that `config.toml` holds defaults. No hero art.
- **No task selected** (projects exist): the new task view, prefilled with the most recently used project. The app never shows a blank main area.
- **Task without sessions**: centered muted line "No sessions" and two buttons: start the agent again (with the task's agent choice), open a shell.

## Status visuals

- Glyph and word for every state (`ux.md` rule kept), plus color, because color is what makes a list scannable at a glance:
  - working: spinner, `--status-working` (blue);
  - needs you (blocked): question glyph, `--status-attention` (amber);
  - error: alert glyph, stock `destructive`;
  - done: check, `--status-done` (green), fades to muted once seen;
  - idle: hollow dot, muted.
- Three status tokens are added to the theme for dark and light; this is the one deliberate change to the stock-everything kit policy (`ui-kit.md`). Glyph sizes: 12 px in rows, 14 px in tabs and header.

## Typography and density

- Stock shadcn tokens, Geist, stock radius and controls stay (`ui-kit.md`). Density comes from layout: 52 px task rows, 32 px tabs, 40 px header, `text-xs` metadata, not from shrinking controls.
- Dark only, as today.

## Board and settings

- Board stays a route, reached by `prefix b` and the palette; it loses its icon in the sidebar. Its future is a review item.
- Settings is a page replacing the main area (sidebar stays), sections in a left list (Keys, Tasks & projects, Naming, Profiles, Agents), each read-only per `ux.md`.

## Review later

Decisions made here for the user to confirm or change after using them:

1. Sessions as tabs only, removed from the sidebar.
2. Flat mode as default, with sections Needs you / Working / Done / Settled.
3. Two-line 52 px task rows and what line 2 shows.
4. New task as a main-area view instead of a dialog; the empty state being that view.
5. Status colors added to the stock theme (blue/amber/green).
6. Terminal padding 8 px.
7. Sidebar 264 px default, `prefix \` to hide.
8. Prefix-armed pill in the sidebar footer as the only global status surface.
9. Board demoted to palette/key only.
10. Chat styling: right-aligned user bubbles, unboxed assistant, folded tool calls.
