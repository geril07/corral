# Layout

Behavior and security: `design.md`; visual direction and kit boundaries: `ui-kit.md`.

Kind: **current state** — what sits where, and why. Measurements are the code's: the kit, the
layout modules and their constants decide them. A piece that moves a surface edits this file in
the same PR, and a description that no longer holds is deleted rather than adjusted.

The current desktop window has a 1024×640 minimum. Smaller layouts have not been decided.

## Visual shell (routed workspace)

The workspace route mounts `VisualShellView` (`apps/web/src/modules/shell`). Its measurements are
kit-owned in `common/ui/visual-shell.css`; the values below are the code's.

- Two columns with no divider: a borderless sidebar on `bg-deep` and one main surface on
  `bg-base`. The sidebar starts at **320** px, resizes **100–640** px and persists per device; a
  window shrink clamps the shown width and never inverts the main surface. The main surface has
  an **8** px outer inset and radius **10**.
- Sidebar insets are start **11**, end **3**, top **8**, bottom **10**. The header is **40** high:
  the wordmark is **15/20** weight **530**, and the toggle is an icon-only **28×28** ghost action.
- The action row sits **4** below the header and holds the wide `Search tasks…` row and New task,
  a **28×28** icon action; `prefix f` opens the same finder. The list starts **16** after the row
  and scrolls independently; card gap is **3**.
- A task card is **52** high: padding **8**, two **16**-high lines with **4** between, radius **6**,
  no border or shadow. The first line carries a **16** px project avatar/icon and the project at
  **11/16** weight **440**; the right slot carries status/time at **11/16** weight **530**. The
  second line is the title at **13/16** weight **530** in every state. Unselected titles use
  `text-muted`, selected titles `text-base`; hover and selection share the one hover overlay.
- The right slot is a fixed **88** px. Hover and keyboard focus swap the status for the **20×20**
  action without moving the title. The action is Settle's slot: it settles an active task and
  unsettles a settled one, named `Settle task` / `Unsettle task`; a host with no task store keeps
  the status instead of offering an action that could not run, and its row menu has no settle item.
  Settling and un-settling change only the task's shelf state: a running session keeps running, and
  the next shell, agent or chat prompt makes the task active again.
- The Settled shelf is the last group of the same scroller, after the active rows, and is
  organizational only: it groups finished work, it does not stop anything. It is a **28**-high
  wide ghost row with the disclosure chevron and `Settled (N)`, then the
  same **52** px cards in the shelf's one order: newest activity, then newest task, then id — the
  server records no settle time, and activity is the **primary** session's report the card shows,
  not the most urgent of all sessions the prior sidebar used. It is collapsed by default and kept
  per device;
  collapsed it mounts only the current task's row, so the main area's task is never hidden. The
  shelf rests at the bottom while the list is short (`margin-top: auto`) and scrolls with the list
  when it is long, so settling a task never moves the active rows above it. Open, it mounts every
  settled row: the prior sidebar paged its measured box, and paging is not built here, so a very
  long settled history costs one card per row.
- The footer is the `ShellStatus` row: the config-problem opener and the prefix hint, with the
  **28×28** Settings and Add project actions beside them. It is **36** high with a top border and
  grows for a failure or guidance sentence. It carries no connection state: a lost server is
  reported above the working area, where the work is. While the sidebar is hidden the strip takes
  the same failure, config problem and armed prefix; only a persistent problem owns a row, and an
  armed prefix floats at the main surface's top-end without reserving layout. Settings and Add
  project stay icon-only with compact tooltips. A config problem opens the problems dialog.
- The connection banner is the first row inside the main surface, above the task row and the
  strip, and is mounted in both sidebar states. It is **36** high with a bottom border and a tone
  tint; it names the state (`Connecting to the server`, `Cannot reach the server`, `The server
  refused this capability`, `That capability cannot be used`, `This app and the server cannot talk
  to each other`), the attempt and elapsed time where the state has one, and offers `Retry now`
  where a retry can help plus `Details`, which opens the capability-recovery dialog. A reconnect
  shows only after **2 s**; a capability or protocol failure shows at once.
- The status slot follows only the task's **primary** agent session. Working has no displayed
  duration; other states use compact ages (`<1m`, `12m`, `2h`) from the report time. Sort order is
  Blocked/Error, unseen Done, Working, then neutral, newest report first inside a group.
- `prefix \` toggles the sidebar. When hidden, the same toggle floats at the main surface's
  top-start corner. Clicking a card selects it and updates the route's `task` search; the review
  host at `/visual-review` (development only) renders the same components with fixture rows for
  rare states. Search, Settle, New task, Settings and Add project are connected to the real
  surfaces.
- The main surface is the selected task's working area: a compact **40** px task row (title,
  project, branch, status, and the word `Settled` for a settled task), the **40** px strip, and the
  optional companion group beside the main pane. The task card shows its title, project initial
  and status; branch, agent and prompt are in the card's metadata tooltip. The panes carry the
  conversation and work.

The routed shell replaces the former workspace and sidebar composition. Shared chat, changes,
terminal and dialog modules remain; old-screen tests can still contain live behavior coverage.

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
- Chat keeps its centered lane, right-aligned user bubble and unboxed assistant text. A finished
  turn folds to one `Worked` row over the calls and reasoning it hid; a run of finished calls
  folds to one verb summary over the calls it hid; a single finished call and a running one keep
  their own rows, and their input and output or diff expand under the row with their own bounds.
  The live turn ends in a `Working` row. With history the transcript keeps a space below its last
  row for the composer at the lane's end; an empty transcript centres the composer in the pane,
  like the new-task composer. Scroll belongs to the pane: the transcript's `log`
  owns it, opening or closing a fold leaves the row that was clicked where it is (the list's end
  follow is released for that layout change), and each session keeps its reading row and open
  folds while the session is open. A pending request overrides the reading position: the transcript
  reveals it and its control takes the keyboard.
- New-task and chat prompts share the bordered composer surface, wrapping control row and arrow
  submit control. The chat prompt reads `Ask anything…`; the control row has no persistent
  shortcut sentence. Send/steer, abort and IME protection retain their existing semantics;
  follow-up is offered only where the driver declares it. The prompt's caret is its focus
  indicator, and its textarea has no resize grip. Repository/checkout/branch controls never belong
  to an existing-task chat composer.
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

## Changes

- A `Changes` tab per task belongs to the companion group. It has no session behind it: no number hint, no status glyph, and selecting it does not change which session is current in the main group.
- The companion pane's width with the Terminal's padding, not the chat lane: diffs are wide and
  get horizontal scroll rather than wrapping.
- A summary row at the top ("12 files, +340 −87", `text-sm`, muted), then compact file rows: status letter (`M`/`A`/`D`/`R`), path in mono truncated from the left, `+N −M` right-aligned. Changed files sort by path; a renamed file shows `old → new`.
- The diff pane under the list: unified hunks, muted hunk headers, monospace on a compact line
  height, unchanged regions folded with "Show N more lines". Binary files show one row ("Binary
  file, 12 KB") and no diff. At the minimum viewport the list collapses to the top third and the
  selected file's diff takes the rest.
- Refreshed with a debounce when the workspace changes: loading shows skeleton rows, a clean tree shows "No changes yet".
- Below the summary row, the finish controls, one line each and all keyboard-reachable: `Stage all` / `Unstage all` / stage-or-unstage the selected file with the staged count, then a one-line commit-message field and `Commit`, then `Push…` and `Create pull request…` (each behind a dialog naming the remote's push URL and the branch; creating also names the base branch and the provider) and the linked request's badge with its check line, or a `Settle task` button once it merged. A refusal shows its sentence under the row and keeps the message and the selection.
- When both the live checkout and the task's recorded value name a branch and they differ, the controls name both: `Checked out now: <live> · the task was created on <recorded>.` No line appears when they agree, the live checkout is detached, or the recorded value is not a branch. The reason `Push…` and `Create pull request…` are unavailable is visible under the controls (`This task has no branch checked out.` for a detached HEAD, no remote, or no remote that would take the branch), never only in a `title`.
- Git read/write and confirmation safety are documented in `engineering.md`.

## New task view

- Still a main-area composer, not a dialog. `prefix t` opens it; Escape returns to the selected
  task and keeps the draft.
- When a workspace or branch picker is open, Escape closes that picker before leaving the draft.
- `Mod+N` chooses a project, skipping the picker when only one exists; `Mod+Shift+N` uses the
  selected task's project or asks when none is current; `Mod+Alt+N` opens a scratch draft. `Mod`
  is Cmd on macOS and Ctrl elsewhere.
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
  `New task`. The working-area identity row is absent while a draft owns the main area.
- Prompt, agent/model and Create controls share the composer. Launch view follows settings; there is
  no per-draft Chat/Terminal switch. One left-aligned
  context row below it names the project, the workspace mode and the branch; setup never sits in
  ongoing chat. The project name reuses the shared project picker, and choosing a project returns
  focus to the prompt. `Current checkout` shows the project's default base as a read-only fact;
  `New worktree` shows `from <branch>` and opens the branch picker. No workspace path or summary
  line sits at the right. The routed composer currently requires a prompt and starts the primary
  agent; title-only creation, issue import and creating a task on an existing branch are not
  exposed there. Existing-branch creation remains server-supported.
- Chat is the built-in default; explicit global/project/view choices win and unsupported chat
  falls back to terminal. Capability loading blocks prompt launches.

## Settings

- A large categorized modal, bounded by the viewport.
  Its left category list selects one panel at a time. Each panel retains its own scroll
  and disclosure state; Appearance does not mix editable device preferences with read-only config.
- The route stays /settings, in the pathless workspace parent: opening it never destroys terminal
  attachment, chat/new-task draft, selection, caret or scroll. The covered
  workspace is inert while the modal is open, so its terminal cannot take the keyboard. Closing
  restores focus. Background prefix bindings and completion seen marks pause while the modal is
  open.
- Appearance edits device-local tab position and interface text scale (80–140%, relative to
  OS/browser scale). Terminal text does not change.
- Models is an editable, server-shared preference category: provider rail, searchable model list,
  allow/deny mode, mixed-state visibility, favorites, draft Preview/Save/Discard, and revision conflicts.
  Provider bulk actions cover the provider, not just search matches; Hide all makes an empty
  allowlist and Show all resets visibility. Search and All/Visible/Hidden/Favorites views are
  temporary. A hidden current chat choice stays as a disabled, labeled row, and the configured
  default's row is marked as such. Picker-owned Settings preserves the picker search/selection as
  well as the workspace underneath. Policy, discovery lifecycle and limits:
  [Model catalogs](model-catalog.md).
- Server config stays read-only: keys, task defaults, naming, project overrides, profiles,
  agent capabilities and config problems. No server config writes or permission bypass.
