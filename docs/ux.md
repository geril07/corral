# UX

Corral is a graphical, keyboard-first workspace for people who live in terminals.
Product behavior: `design.md`. Placement, sizes and surfaces: `layout.md`. Kit provenance, defaults and boundaries: `ui-kit.md`.
Actual code/tests remain authoritative where older research described proposals.

## Stock shadcn appearance

Use the official **default Base UI / Nova** preset and its canonical neutral theme,
Geist typography, radius scale, component sizing, corners, hover/focus treatments
and transitions. Dark mode is the starting mode; no theme-toggle feature is added.
The former Corral blue palette, 13px body, 28px controls and custom dialog geometry
are not policies: the user explicitly superseded appearance preservation with stock
shadcn throughout the application.

Modules compose kit components and named structural variants, never skin controls
with `className`. Structural page/tree grids and semantic content typography remain
allowed. UI-boundary, AST class/control and token gates enforce this separation.
A required variant must solve a current structural need, not hide the old skin.
Stock primitive appearance remains identifiable; the permitted adaptations (no popup exit animations, one unpadded dialog footer, a wider row overflow menu, the hint delay) are listed in `ui-kit.md`.

## Target flow (stages A and B built)

What a user does. Items 1–3, 5–7 are built and verified end to end (stage A, `progress.md`); item 3's chat view and the chat halves of items 1–2 (B1, B3, B5) and item 4's handoff (B4) are stage B. Keys listed here are the effective defaults.

1. `prefix t` opens the new-task view in the main area (`layout.md`, **New task view**): a prompt field, plus project (current), agent · model, workspace and view, all prefilled from settings and changeable from the keyboard. Enter submits.
2. The task appears in the sidebar at once under the prompt-derived seed title, which the generated title replaces. Its primary agent opens in the chosen view, already working on the prompt. No shell opens on its own.
3. Inside a task (header and tab strip: `layout.md`), sessions are equal tabs: agents (terminal or chat) and shells. `prefix c` adds a shell, `prefix s` another agent, `prefix n`/`p` or `prefix 1`–`9` switch tabs. Chat is a tab kind, not a separate mode or a bottom panel. `prefix shift+c` opens the task's `Changes` tab after the sessions: a read-only view of what the task changed, with no number hint and no status glyph, and it leaves the current session where it was — the arrow keys in the strip keep moving between sessions, and choosing a session tab returns to it.
4. `prefix v` hands the current agent session over between chat and terminal: one frontend is
   stopped and its process waited for, then the other starts on the same agent conversation, so
   the session keeps its name, its tab and its history. An idle agent switches at once; a working
   one asks first, because the handoff ends that turn — aborted in chat, cut when a terminal's PTY
   closes — and a request the agent is waiting on is cancelled with the frontend. The confirmation
   names both, per direction, together with what survives (the conversation the agent already wrote). While the switch runs, the main area says "Switching this session to …" instead
   of showing a half-switched pane. Only an agent with a chat driver has two views: the palette
   shows the action disabled with the reason for a shell or a driverless agent, and pressing the key
   there does nothing. A handoff whose second start fails leaves the session stopped in the target
   view with the launch error and its Start again button, and `prefix v` on a stopped session only
   chooses the view its next start opens in. OpenCode can keep both live and whether Codex's
   terminal is view-only while chat writes is measured when its driver starts (stage C).
5. The sidebar lists tasks either flat by status (sections Needs you, Working and Done, plus a settled shelf; the default) or grouped by project; `prefix l` toggles the mode and the device keeps its choice. A task's status is the most urgent of its sessions', ordered: needs approval or input, error, working, completed and unseen, idle. "Completed and unseen" clears when the task is opened or its status changes while it is selected.
6. `prefix f` finds a task, `prefix j`/`k` steps through tasks, `prefix e` renames the task (session rename stays `prefix shift+r`), `prefix d` settles.
7. Settings carry the defaults the composer uses: view (global, overridable per project), workspace mode, worktree root, branch prefix, slug mode, naming agent/model; and the agents, whether each is found and which have a chat driver.

## Layout and navigation

- Three places: the sidebar of tasks, the main area's task header and session tabs, and the
  session below them (`layout.md`). The sidebar is a fixed pane the user resizes; the terminal
  takes the rest of the main area. There is no title bar of our own and no global status bar.
- The sidebar lists tasks only. Its 44 px header is task search with its chord plus a new-task
  button; its 36 px footer carries the connection state while it is not connected, the
  prefix-armed pill, config problems and Settings. It is 264 px by default (232 px below
  1180 px), dragged between 208 and 420 px with the edge handle — and never so wide that the
  main area drops below its 640 px — kept per device, reset by a double click, and hidden or
  shown by `prefix \`.
- Flat mode by status is the default (`prefix l` switches to project groups and the device keeps
  the choice). Rows are the two-line 52 px task rows of `layout.md`; selection uses stock
  secondary appearance plus `aria-current`, not a bespoke colored left bar. Titles and paths
  truncate without losing accessible names. Loose terminals sit in the Scratch section, one line
  each, and only while some exist.
- The main area shows one task: a 40 px header (title, `project › branch`, status word with its
  glyph, the primary agent and model, settle and the task menu), a 32 px tab strip with one tab
  per session in creation order, and the selected session below. A tab shows its number hint, its
  kind icon (replaced by the status glyph while working or blocked), its name, and — on hover or
  focus — stop or restart, its menu and close; a trailing "+" offers a shell or an agent.
  `prefix 1`–`9`, `prefix n`/`p` and clicks select tabs, and the selected tab stays in view.
  After the sessions, a `Changes` tab holds the task's changed files (`layout.md`, **Changes**);
  while it is open the current session keeps its place in the strip and a `+N −M` count sits in the
  task header and the sidebar row when the task changed something.
- The main area never goes blank: with no task selected it is the new-task composer, prefilled
  with the current project. `prefix t` shows the composer over the selected task and Escape
  returns to that task, with the keyboard back in its terminal.
- Clicking navigation, tabs or the task header must not take the keyboard from the terminal; a
  dialog returns focus to its opener and, failing that, to the terminal (see **Focus, keyboard
  and errors**).
- Row actions use named icon buttons and menus. Session stop/restart, rename and remove live on
  the session's tab and in the palette; renaming a session keeps `prefix shift+r`, removing it
  asks first. Icons are Lucide's standard glyphs.
- One scrolling region per pane. At 1024×640 and above all controls must be reachable. Long
  forms may scroll inside the stock dialog with a viewport-relative height cap; do not
  shrink/reposition stock controls to recreate the former density.

## Tasks, sessions and sources

- Add project is a path dialog with inline errors. New task is the composer view in the main
  area (`layout.md`, **New task view**), not a form dialog: a prompt, then project, agent · model
  and workspace pickers prefilled from the effective settings, with an optional title and an
  issue import that expand in place. Enter creates the task and starts its primary agent with the
  prompt as its launch argument; a task created from the optional title alone starts no session,
  so it stays empty until a shell or an agent is added. Project changes clear project-specific
  import and branch state safely; issue import feeds the composer's prompt (the issue's title and
  link) and keeps its source snapshot as the task's title context.
- Radio groups retain the stock stacked default. Provider/agent/workspace choices
  use stock fields and labels, not custom selectable cards or row skins.
- Remove task retains the dirty-worktree second confirmation; keyed buttons prevent
  a single Enter from confirming both stages. No branches are deleted implicitly.
- Rename is a focused dialog, the same one for a task's title, a session label and a loose terminal label. Session labels persist; loose terminal labels survive
  only for their terminal's lifetime. The historical first-character risk remains
  unexplained; changing kits is not evidence of a fix.
- Imported source is immutable original title/body/link context, displayed as escaped
  text. Pending/cancel/project-switch guards and manual-title preservation remain.

## Focus, keyboard and errors

- Dialogs capture their opener, suspend prefix handling and restore the connected
  opener, with the active terminal textarea as fallback. Keyboard-opened dialogs
  capture the current target rather than reusing a previous pointer opener.
- First input receives focus; destructive confirmation starts on Cancel. Escape and
  outside interaction use Base UI behavior; destructive outside clicks do not close.
- Menus, dialogs, popups and the palette keep their stock focus treatment and enter
  transitions, but close immediately: a closing popup must not hold the keyboard, so
  no exit animation delays its unmount. Tests then assert one live popup or the
  terminal's first character instead of waiting for a transition. The prefix never
  handles keys while a task dialog is open.
- Errors stay with the form at `role="alert"`; failed submissions preserve input. The composer
  is a view, so it holds no opener: Enter submits, Shift+Enter is a newline in the prompt, Escape
  returns to the previously selected task, and a create that waits for naming (worktree mode)
  shows "Creating…" with the prompt still editable. While a failed create is on screen, Escape
  stays in the composer: leaving would hide what went wrong, so the user fixes it or picks another
  task in the sidebar, and the draft is kept either way. The draft (prompt, title, picks and issue
  snapshot) lives in the workspace: a project navigation keeps the typed prompt and title, drops
  what only the old project owned (the issue snapshot, an imported prompt, an existing branch) and
  lets the untouched fields follow the new project's settings. An Enter that confirms an IME
  composition is never a submission, whichever order the platform reports the keydown and the
  composition end; the user's next plain Enter submits normally.
  Connection/protocol mismatch notices remain app-level, not transient success toasts.
- Chat keeps the composer semantics of the new-task view: Enter sends, Shift+Enter is a newline,
  and while a turn runs Enter steers and Ctrl/Cmd+Enter queues a follow-up (the composer says
  which). `prefix .` aborts the working turn and the palette lists the same action.
- The chat's control row shows the model and reasoning level the driver reported; each opens a
  keyboard-first list of what the driver offers (type to filter, Enter applies) and the same two
  choosers are palette actions, `prefix m` for the model and `prefix shift+m` for the level. A
  refused choice keeps the list open with a sentence naming the model or level the agent does not
  offer. A terminal session has no model or level control.
- The composer's view control offers `terminal` always and `chat` only for an agent
  `chat.capabilities` reports a driver for. A `[tasks] view = "chat"` (or a project's) that names
  an agent without a driver is reported as a config warning and opens in the terminal; when the
  user picks such an agent in the composer the view control moves to `terminal` and says why. A user request
  arrives as the last timeline item with the keyboard: arrows and Enter answer `select` and
  `confirm`, Enter answers `input`, Ctrl/Cmd+Enter answers `editor`, and Escape dismisses any of
  them. Prefix mode is the window capture-phase handler, so it works while the composer and the
  chat have the keyboard and plain keys stay in the field. The transcript is a focusable `log`: PageUp/PageDown,
  Home/End and the arrow keys scroll it without a pointer; moving up releases the end follow and
  End takes it again. A fold that expands while the user reads above the end does not drag the
  view back to the tail.

### Local links in chat

- A path an agent writes in an answer is a link when the task's workspace actually holds it:
  absolute paths, workspace-relative paths and `file.ts:12[:3]` are recognised, and the server
  resolves them through the workspace (`files.resolve`) — a `..` path, an absolute path elsewhere,
  a symlink out of the workspace and a path that does not exist all stay plain text rather than
  becoming a dead link. Code spans and fenced blocks are never linkified.
- A file link opens in the editor: `[editor] command`, else `$VISUAL`, else `$EDITOR`
  (`agent-profiles.md`, **The editor for local file links**), run as a terminal in the task's
  workspace, which is then selected. The line and column the message named travel only through a
  `{line}`/`{column}` placeholder. A refusal (nothing configured, the executable is missing) is a
  sentence above the composer, not silence.
- Images and videos in the workspace preview inline, bounded by size and type (4 MB images,
  8 MB video). The preview is a button: Enter or Space opens a lightbox, Escape closes it, and the
  video plays there. A media file past the bound is one row with its size and an Open button — never
  a broken frame. Any other file, binary or not, is a link that opens the editor.
- An ordinary web link never loads in the app window (`design.md`, **Local trust boundary**): the
  desktop app hands it to the OS browser over the preload bridge, and in a browser it opens a new
  tab. The app's own URL — and the task being looked at — stay where they were.

- Clicking navigation must not steal terminal focus. Tooltip content is optional;
  it cannot hold the only copy of a fact. Accessible names identify every icon action.
- Status is a named state plus a distinct glyph, with stock semantic theme colors.
  No custom status or terminal palette is added.

## Palette, search and settings

- The palette lists every effective binding in fixed Sessions, Tasks, Projects,
  Navigation and General groups, using official CommandDialog/Command components. An action that
  cannot run now is shown disabled next to the reason it cannot (e.g. "The claude agent has no chat
  driver in this build.").
- A new default binding can take a chord an existing `config.toml` gave to another action:
  the file's entry is dropped, that action falls back to its own default, and Settings reports
  the conflict.
- Task search shares cmdk and the watched client task set. Enter inspects a result;
  inspecting settled history does not continue it. Continue is explicit.
- Settings is read-only: actual config path, effective bindings, problems, profile
  descriptors, the effective task defaults and naming, each project's overrides, and the agents
  (`[agents.<kind>]`: enabled, the command a launch runs, whether it is found, and whether this
  build has a chat driver).
  `config.toml` remains the source of truth; no write controls are added.
  Composer defaults (Target flow 7) are config entries too, overridable per project
  (`design.md` decision 17); Settings shows each effective value and where it came from
  (`default`, `global`, `project`), shows only the keys a project overrides, and says so
  when `[naming]` is empty, so tasks keep their prompt-derived seed titles.
- Agent selection offers native defaults, named profiles and supported model overrides.
  Changed/deleted profiles require explicit reselection; no silent fallback. Session
  details describe saved launch snapshots, never resolved environment values.

## Known limits

- Desktop support begins at 1024×640; smaller responsive layouts remain undecided.
- Long values may truncate; names and effective summaries retain their full meaning.
- Font +/-/reset exists in playtest but not Corral. Terminal text remains fixed at
  14px; adding controls is separate scope. UI typography itself is stock shadcn.
- Hover-only row actions and settings writes are not implied by this kit migration.
  Mid-session model and reasoning switching belongs to a chat driver; a terminal session has no
  such control.
