# Layout

Behavior: `design.md`; interaction: `ux.md`; visual direction and kit boundaries: `ui-kit.md`.

Kind: **current state** — what sits where, and why. Measurements are the code's: the kit, the
layout modules and their constants decide them. A piece that moves a surface edits this file in
the same PR, and a description that no longer holds is deleted rather than adjusted.

## Visual shell (routed workspace)

The workspace route mounts `VisualShellView` (`apps/web/src/modules/shell`). Its measurements are
kit-owned in `common/ui/visual-shell.css`; the values below are the code's.

- Two columns with no divider: a borderless sidebar on `bg-deep` and one main surface on
  `bg-base`. The sidebar starts at **320** px, resizes **100–640** px and persists per device; a
  window shrink clamps the shown width and never inverts the main surface. The main surface has
  an **8** px outer inset and radius **10**.
- Sidebar insets are start **11**, end **3**, top **8**, bottom **10**. The header is **40** high:
  the wordmark is **15/20** weight **530**, and the toggle is an icon-only **28×28** ghost action.
- The action row sits **4** below the header: Search is a **28**-high wide ghost row (inline padding
  **8**, gap **8**, radius **6**, **13/16** text) and New task is a **28×28** icon action. The list
  starts **16** after the row and scrolls independently; card gap is **3**.
- A task card is **52** high: padding **8**, two **16**-high lines with **4** between, radius **6**,
  no border or shadow. The first line carries a **16** px project avatar/icon and the project at
  **11/16** weight **440**; the right slot carries status/time at **11/16** weight **530**. The
  second line is the title at **13/16** weight **530** in every state. Unselected titles use
  `text-muted`, selected titles `text-base`, and a settled row's title stays `text-faint`
  (`text-muted` when selected) because the shelf already names its state; hover and selection share
  the one hover overlay.
- The right slot is a fixed **88** px. Hover and keyboard focus swap the status for the **20×20**
  action without moving the title. The action is Settle's slot: it settles an active task and
  unsettles a settled one, named `Settle task` / `Unsettle task`; a host with no task store keeps
  the status instead of offering an action that could not run.
- The Settled shelf is the last group of the same scroller, after the active rows: a **28**-high
  wide ghost row (the Search row's recipe) with the disclosure chevron and `Settled (N)`, then the
  same **52** px cards in the shelf's one order. It is collapsed by default and kept per device;
  collapsed it mounts only the current task's row, so the main area's task is never hidden. The
  shelf rests at the bottom while the list is short (`margin-top: auto`) and scrolls with the list
  when it is long, so settling a task never moves the active rows above it.
- The footer is **28** high with **28×28** Settings and Add project actions, gap **4**, start
  aligned. Both are icon-only with compact tooltips.
- The status slot follows only the task's **primary** agent session. Working has no displayed
  duration; other states use compact ages (`<1m`, `12m`, `2h`) from the report time. Sort order is
  Blocked/Error, unseen Done, Working, then neutral, newest report first inside a group.
- `prefix \` toggles the sidebar. When hidden, the same toggle floats at the main surface's
  top-start corner. Clicking a card selects it and updates the route's `task` search; the review
  host at `/visual-review` (development only) renders the same components with fixture rows for
  rare states. Search is deferred; Settle, New task, Settings and Add project are connected to the
  real surfaces.
- The main surface is the selected task's working area: a compact **40** px task row (title,
  project, branch, status, and the word `Settled` for a settled task), the **40** px strip, and the
  optional companion group beside the main pane. The task card shows its title, project initial
  and status; branch, agent and prompt are in the card's metadata tooltip. The panes carry the
  conversation and work.

The sections below describe the prior workspace composition. Those modules and their tests remain
in the tree for the parts that are still useful (chat, changes, terminal, dialogs), but the
workspace route no longer mounts the old `WorkspaceScreen` or `Sidebar`.

## Task header

- Read-only repository/worktree-branch context, separator, task title; both truncate with their
  complete accessible name and a tooltip. A draft has no task header: its tab in the strip names
  the project. The branch is the task's recorded create-time fact, shown as `<branch> (recorded)`
  and recorded at create in the accessible name; a detached create shows `detached`, never `HEAD`.
  The header does not claim it is the current checkout: Changes names the live branch when it
  differs.
- The task's status sits after the change counts and linked-request badge, before the overflow
  menu. This legacy header still uses the most urgent of all sessions; the routed shell's card uses
  the primary session only. In the sidebar's vocabulary: a glyph alone
  for working, a muted glyph and no word for idle, the glyph with its attention word (`needs
  approval`, `needs input`, `needs auth`, `error`, `blocked`) when the task needs the user, and a
  `done` glyph that is muted once seen. Nothing renders when no session reports a status. A settled
  task shows it as the sidebar does. It also carries the sidebar's word `Settled` in the trailing
  group: muted text outside the status slot, before the change counts, with no glyph or colour of
  its own. The word is derived from the task's state and gone when the task is active.
- The context and title are text: a mouse drag selects them, while the row's controls keep
  `mousedown` cancelled so clicking one does not take the keyboard from the terminal.
- The repository label never secretly copies a path.
- Keep existing nonzero change counts and linked pull-request badge; Changes is not redesigned.
- A discoverable task overflow menu holds settle/unsettle, rename, explicit Copy workspace path,
  Copy branch when the task has a recorded branch, imported issue source when present, and remove.
  No duplicate model or unexplained sync badge.
- Each copy names its outcome in one `role="status"` line inside the header: "Workspace path
  copied", "Branch copied", or the clipboard's own refusal sentence. The line is a polite live
  region, is reachable by the menu's keyboard path, and the next header action clears it.

## Working area

- One task is one working area with two tab groups. The main group is always visible; the
  companion group is hidden until it has a tab, and a toggle with no companion tab opens
  `Changes`. There is never an empty half. The strip band is **40** high inside the main
  surface's **8** inset and **10** radius.
- A tab is **28** high, radius **6**, inline padding **6** with **26** reserved at the end for the
  close control, gap **6**, icon **16**, title **13/16** weight **530**, maximum **200**. The
  status glyph leads the title; the primary tab has no close control. Hover takes the one hover
  overlay, the selected tab the pressed overlay, and neither adds a border. The close control is
  **20×20** at inset **4** and appears on hover or keyboard focus only. Two inactive neighbours
  share a **1.5×12** separator.
- Tabs keep a **72** px minimum and then scroll horizontally with **24** px edge fades; the active
  tab is scrolled into view. The trailing `+` and the `Changes` action do not scroll away.
- The first tab of the main group is the task's **primary** session: `Task.primarySessionId`,
  created with the task. Moving that tab between groups is refused, so the primary stays first;
  its close control stays absent and only the destructive `Remove session…` removes it.
- The rest of the tabs are sessions (an agent or a shell) and the task's `Changes`. A file tab
  promoted from a preview is not built yet. Chat and Terminal are **one** tab: the same session
  switches view in place, and a both-live agent still has one tab. A task with no sessions keeps
  the strip's `+`/`Changes` actions and repeats the same `+` add-session menu in the empty pane,
  never a fake tab.
- Session tabs carry a number **1–9** counted over the session tabs inside their group; `Changes`
  carries no number and no status glyph. Every session tab's glyph slot shows the tool or shell
  logo, a working, blocked or error glyph, and a failed or unresumable session uses the error
  glyph. The accessible name carries the session's badge; stop/restart, the Chat/Terminal view
  item, rename and the destructive remove live in the tab's context menu.
- The companion group has its own strip and pane, separated by a **1** px border with an **8** px
  drag hit area. At the 1024 floor with the sidebar hidden the main pane keeps **560** and the
  companion can use **320–448**; the stored 600 clamps to 448. With the sidebar shown the
  companion keeps **320** and the main pane gives up part of its own. Closing the last companion
  tab collapses the group; toggling it shut keeps the pane mounted. The companion width and the
  strip's top/bottom position are device-local.
- Selection, order, group and the active tab are stored per task and device under
  `corral.task-tabs.<task id>`, with a closed stack of every closed view. Closing a session tab closes the
  view, not the session; reopening restores its group and order. The route keeps naming the task.
- `prefix c` and `prefix s` add a shell or an agent and focus the new main-group tab;
  `prefix shift+c` opens `Changes` in the companion group without changing the current session.
  `prefix q`/`shift+q` close and reopen, `prefix shift+b` toggles the companion,
  `prefix shift+o` moves the focused tab to the other group, and `prefix shift+w` toggles the
  focus between the groups. Number and `n`/`p` navigation act inside the focused group; when a
  companion holds only `Changes` they act on the main group. A refused close of the primary or a
  refused move says so in the one line above the strip, and choosing a tab clears that line.

## Terminal and chat

- Terminal keeps its own padding, native xterm rendering, and monospace text that does not follow
  the interface text scale. It fits its own pane on attach, reconnect, focus and a settled resize,
  then asks the shared PTY to follow; the PTY's grid stays authoritative for every client.
- Chat keeps its centered lane, right-aligned user bubble and unboxed assistant text.
  Reasoning and tool calls keep their folds and independently bounded output/diffs.
- New-task and chat prompts share the bordered composer surface and wrapping control row.
  Send/steer, abort and IME protection retain their existing semantics; follow-up is offered only
  where the driver declares it. The prompt's caret is its focus indicator, and its textarea has no
  resize grip. Repository/checkout/branch controls never belong to an
  existing-task chat composer.
- One bounded picker serves creation, add-agent and live chat: tool/profile icon rail, searchable
  model column and the selected model\'s thinking column. A live-chat popup anchors above its
  control and fits available width/height; add-agent anchors to the session adder. Without an
  anchor the same body uses a task dialog. Existing-chat model selection keeps it open; thinking
  applies and closes. A new launch commits its native/configured model row. Current choices are marked.
  Live catalogs and thinking come from the driver, not prototype fixtures. Before launch,
  pi/OpenCode inventories come from scoped, short-lived native metadata probes; unsupported
  selection rows are disabled. Configured/native defaults and supported raw IDs remain available.
  The right column explains why pre-launch thinking is unavailable. The footer links to Models
  management and shows the visible/known count; shared visibility is not a launch permission policy.
- No illustrative context usage, model availability or Full access permission appears as a fact.

## Changes (stage C)

- A `Changes` tab per task belongs to the companion group. It has no session behind it: no number hint, no status glyph, and selecting it does not change which session is current in the main group.
- The companion pane's width with the Terminal's padding, not the chat lane: diffs are wide and
  get horizontal scroll rather than wrapping.
- A summary row at the top ("12 files, +340 −87", `text-sm`, muted), then compact file rows: status letter (`M`/`A`/`D`/`R`), path in mono truncated from the left, `+N −M` right-aligned. Changed files sort by path; a renamed file shows `old → new`.
- The diff pane under the list: unified hunks, muted hunk headers, monospace on a compact line
  height, unchanged regions folded with "Show N more lines". Binary files show one row ("Binary
  file, 12 KB") and no diff. At the minimum viewport the list collapses to the top third and the
  selected file's diff takes the rest.
- The task header shows `+N −M` right-aligned next to the status when non-zero, and a linked pull request's badge (`PR #7 open`) before the status; the sidebar row shows the same compact numbers, and the request's name and state, only when they exist.
- Refreshed with a debounce when the workspace changes: loading shows skeleton rows, a clean tree shows "No changes yet".
- Below the summary row, the finish controls, one line each and all keyboard-reachable: `Stage all` / `Unstage all` / stage-or-unstage the selected file with the staged count, then a one-line commit-message field and `Commit`, then `Push…` and `Create pull request…` (each behind a dialog naming the remote's push URL and the branch; creating also names the base branch and the provider) and the linked request's badge with its check line, or a `Settle task` button once it merged. A refusal shows its sentence under the row and keeps the message and the selection.
- When both the live checkout and the task's recorded value name a branch and they differ, the controls name both: `Checked out now: <live> · the task was created on <recorded>.` No line appears when they agree, the live checkout is detached, or the recorded value is not a branch. The reason `Push…` and `Create pull request…` are unavailable is visible under the controls (`This task has no branch checked out.` for a detached HEAD, no remote, or no remote that would take the branch), never only in a `title`.

## New task view

- Still a main-area composer, not a dialog. `prefix t` opens it; Escape returns to the selected
  task and keeps the draft.
- The open draft is a tab in the working area's main group, in the same 40 px strip as a task's
  tabs and with the same close control; its pane is the composer. Opening New task for a project
  that already has a draft selects that draft instead of creating a second one, and a No project
  draft is its own. Closing the draft's tab discards it (OpenCode's close is destructive for a
  draft) and offers Undo in the sidebar notice, which restores the draft's text and strip position
  (clamped to the strip's length); the Undo refuses when the project has a draft with new content,
  and a create for that project clears the notice. Escape and a task selection only put it away.
- Drafts are device-local: one versioned record, `corral.task-drafts`, holds the drafts with
  something typed — prompt, project, agent/model, workspace mode and base branch — written 300 ms
  after the last edit and, while an edit is still pending, flushed before unload. A draft with
  nothing typed is never written and
  disappears when it is closed or the page reloads; reopening New task restores the text, the
  choices and the prompt's focus. There is no server draft, no protocol type and no draft URL, and
  no draft row in the sidebar: while a draft is open no task, project or loose-terminal row is
  current.
- The strip labels every draft tab with its project (or `No project`, or `Project unavailable`);
  the pencil glyph says it is a draft, the visible number is the chord that selects it under the
  default bindings (`prefix 1`–`9`), and the accessible name and tooltip still begin with
  `New task`. The task header is absent while a draft owns the main area.
- Prompt and agent/model, Chat/Terminal and Create controls share the composer. One left-aligned
  context row below it names the project, the workspace mode and the branch; setup never sits in
  ongoing chat. The project name reuses the shared project picker, and choosing a project returns
  focus to the prompt. `Current checkout` shows the project's default base as a read-only fact;
  `New worktree` shows `from <branch>` and opens the branch picker. No workspace path or summary
  line sits at the right. Prompt starts the primary agent; a title-only task starts no session.
  Optional title stays.
- Chat is the built-in default; explicit global/project/view choices win and unsupported chat
  falls back to terminal. Capability loading blocks prompt launches, not title-only creation.
- From issue is a secondary Task setup actions menu entry, not an everyday creation control.

## Settings

- A large categorized modal, bounded by the viewport.
  Its left category list selects one panel at a time. Each panel retains its own scroll
  and disclosure state; Appearance does not mix editable device preferences with read-only config.
- The route stays /settings, in the pathless workspace parent shared with the board: opening it
  never destroys terminal attachment, chat/new-task draft, selection, caret or scroll. The covered
  workspace is inert while the modal is open, so its terminal cannot take the keyboard. Closing
  restores focus. Background prefix bindings and completion seen marks pause while the modal is
  open.
- Appearance edits device-local tab position and interface text scale; the offered range is a
  user-facing promise and is stated in `ux.md`, **Known limits**. Terminal text does not change.
- Models is an editable, server-shared preference category: provider rail, searchable model list,
  allow/deny mode, mixed-state visibility, favorites, draft Preview/Save/Discard, and revision conflicts.
  Picker-owned Settings preserves the picker search/selection as well as the workspace underneath.
  Policy, discovery lifecycle and limits: [Model catalogs](model-catalog.md).
- Server config stays read-only: keys, task defaults, naming, project overrides, profiles,
  agent capabilities and config problems. No server config writes or permission bypass.

## Board

- A full-screen layer over the mounted workspace, at /board and reached by key/palette. It is a
  screen, not a dialog: no scrim and no second scrollbar. The covered workspace is inert and hidden
  from the accessibility tree while it is open, so its terminal cannot take the keyboard. Escape
  and Back return to the same task and URL; closing restores the keyboard. Drafts, collapsed
  groups, list scroll and terminal attachment survive the visit, and the workspace prefix is paused
  while it is open.

## Empty states and scope

- No repository (the project list has loaded and is empty): Add a repository to start with an
  inline path field and Add.
- A project with no tasks opens its composer — from Add project, from its New task action, or on
  its URL — never a loose terminal.
- Task without sessions: No sessions with Start agent / Open shell; its tab row still offers +. A settled task keeps both starts disabled, hides their key hints and shows `This task is settled. Continue it first.`
