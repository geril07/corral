# Layout

Behavior: `design.md`; interaction: `ux.md`; visual direction and kit boundaries: `ui-kit.md`.

Kind: **current state** — what sits where, and why. Measurements are the code's: the kit, the
layout modules and their constants decide them. A piece that moves a surface edits this file in
the same PR, and a description that no longer holds is deleted rather than adjusted.

## Shell

- Two columns: resizable sidebar and one task workspace. No synthetic title bar or global
  status bar. Independent shells are session tabs, never a separate chat dock.
- Sidebar has a default width, a narrow-window default and a drag range that leaves the main
  area its minimum at and above the supported floor (`sidebar-pane.ts` owns the numbers). The
  width persists per device, a window shrink only clamps the shown width, and an edge
  double-click resets it.
- The sidebar toggle is opposite the corral wordmark. While hidden it is in the main header;
  `prefix \\` still works.
- Two distinct rows remain visible for a task or draft: repository/task header, then session
  navigation. A device setting puts the session row above or below content.
  No rows are invented before the first repository is added.

## Sidebar

- Wordmark/toggle header, then Search, grouping and New task.
  Search's tooltip carries its effective chord without crowding the compact toolbar.
- Group by project by default. Status grouping (Needs you, Working, Done) is still available
  through its button and `prefix l`, remembered on this device.
- Two-line task rows: status glyph, clipped title, relative time/attention word;
  secondary metadata names the agent, worktree branch and, outside project groups, project.
  Keep existing change counts and linked request state. Unseen completion stays marked.
- Right-click / menu key / Shift+F10 opens secondary task actions. No action gutter takes
  permanent width. Full names stay accessible and get a tooltip when clipped.
- One Settled shelf is anchored below the active list, above the footer, across all projects.
  It starts collapsed, expands in pages and has a separately scrolling list. A selected older
  task reveals itself, even beyond the first page, without resuming it.
  General task search still includes settled history.
- Loose terminals remain in Scratch when present.
- Footer: Settings and Add project, exceptional connection/config notices, prefix hint
  on the right (armed prefix remains visibly distinct).

## Task header

- Read-only repository/worktree-branch context, separator, task title; both truncate with their
  complete accessible name and a tooltip. The draft names its actual repository and New task.
- The repository label never secretly copies a path.
- Keep existing nonzero change counts and linked pull-request badge; Changes is not redesigned.
- A discoverable task overflow menu holds settle/unsettle, rename, explicit Copy workspace path,
  imported issue source when present, and remove. No duplicate model or unexplained sync badge.

## Session tabs

- Content-width tabs within a maximum, horizontally scrollable with the selected tab in view.
  Number hints 1–9 retain their existing prefix bindings. A draft gets a draft indicator,
  not a fake server session or a premature add-session action.
- Real tool/shell logo in one stable slot; working/blocked status replaces it without shifting
  the tab. Full label remains accessible and clipped labels get a focus/hover tooltip.
- Stop/restart, rename and remove live in the context menu and palette, not three invisible
  hover-action slots. A trailing + opens the same compact menu scale as task actions.
- Chat/Terminal is in this row. It uses the existing driver capability and safe handoff action:
  a busy handoff-only agent still asks before ending its turn, both-live agents keep running,
  and shells/unsupported drivers explain why chat is unavailable. It is disabled on Changes.

## Terminal and chat

- Terminal keeps its own padding, native xterm rendering, and monospace text that does not follow
  the interface text scale.
- Chat keeps its centered lane, right-aligned user bubble and unboxed assistant text.
  Reasoning and tool calls keep their folds and independently bounded output/diffs.
- New-task and chat prompts share the bordered composer surface and wrapping control row.
  Send/steer/follow-up, abort and IME protection retain their existing semantics.
  Repository/checkout/branch controls never belong to an existing-task chat composer.
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

- A `Changes` tab per task sits in the session tab strip after the task's sessions. It has no session behind it: no number hint, no status glyph, and selecting it does not change which session is current.
- Full main-area width with the Terminal's padding, not the chat lane: diffs are wide and get
  horizontal scroll rather than wrapping.
- A summary row at the top ("12 files, +340 −87", `text-sm`, muted), then compact file rows: status letter (`M`/`A`/`D`/`R`), path in mono truncated from the left, `+N −M` right-aligned. Changed files sort by path; a renamed file shows `old → new`.
- The diff pane under the list: unified hunks, muted hunk headers, monospace on a compact line
  height, unchanged regions folded with "Show N more lines". Binary files show one row ("Binary
  file, 12 KB") and no diff. At the minimum viewport the list collapses to the top third and the
  selected file's diff takes the rest.
- The task header shows `+N −M` right-aligned next to the status when non-zero, and a linked pull request's badge (`PR #7 open`) before the status; the sidebar row shows the same compact numbers, and the request's name and state, only when they exist.
- Refreshed with a debounce when the workspace changes: loading shows skeleton rows, a clean tree shows "No changes yet".
- Below the summary row, the finish controls, one line each and all keyboard-reachable: `Stage all` / `Unstage all` / stage-or-unstage the selected file with the staged count, then a one-line commit-message field and `Commit`, then `Push…` and `Create pull request…` (each behind a dialog naming the remote's push URL and the branch; creating also names the base branch and the provider) and the linked request's badge with its check line, or a `Settle task` button once it merged. A refusal shows its sentence under the row and keeps the message and the selection.

## New task view

- Still a main-area composer, not a dialog. `prefix t` opens it; Escape returns to the
  selected task. The task header and draft session row remain visible.
- Prompt and agent/model, Chat/Terminal and Create controls share the composer. Project and
  workspace setup sit below it, never in ongoing chat. Prompt starts the primary agent;
  a title-only task starts no session. Optional title stays.
- Chat is the built-in default; explicit global/project/view choices win and unsupported chat
  falls back to terminal. Capability loading blocks prompt launches, not title-only creation.
- From issue is a secondary Task setup actions menu entry, not an everyday creation control.

## Settings

- A large categorized modal, bounded by the viewport.
  Its left category list selects one panel at a time. Each panel retains its own scroll
  and disclosure state; Appearance does not mix editable device preferences with read-only config.
- The route stays /settings, backed by a pathless workspace parent: opening it never destroys
  terminal attachment, chat/new-task draft, selection, caret or scroll. Closing restores focus.
  Background prefix bindings and completion seen marks pause while the modal is open.
- Appearance edits device-local tab position and interface text scale; the offered range is a
  user-facing promise and is stated in `ux.md`, **Known limits**. Terminal text does not change.
- Models is an editable, server-shared preference category: provider rail, searchable model list,
  allow/deny mode, mixed-state visibility, favorites, draft Preview/Save/Discard, and revision conflicts.
  Picker-owned Settings preserves the picker search/selection as well as the workspace underneath.
  Policy, discovery lifecycle and limits: [Model catalogs](model-catalog.md).
- Server config stays read-only: keys, task defaults, naming, project overrides, profiles,
  agent capabilities and config problems. No server config writes or permission bypass.

## Empty states and scope

- No repository: Add a repository to start with an inline path field and Add.
- Repository but no selection: the new-task composer, never a blank main area.
- Task without sessions: No sessions with Start agent / Open shell; its tab row still offers +.
- Board stays a separate route, reached by key/palette.
