# UX

Corral is a graphical, keyboard-first workspace for people who live in terminals.
Product behavior: `design.md`. Placement, sizes and surfaces: `layout.md`. Kit provenance, defaults and boundaries: `ui-kit.md`.
Actual code/tests remain authoritative where older research described proposals.

Kind: **contract** for keys, focus and the user-visible flows; measurements belong to the code.
The prose that describes a surface is current state: a piece that changes it edits this file in
the same PR.

## Appearance

Visual direction is stated once, in `ui-kit.md`; the surfaces below follow it.
Dark neutral surfaces, blue accents and restrained borders live in the shared kit;
Base UI still owns accessible interaction and popup lifecycles. See `ui-kit.md`.
Modules never skin controls with `className`; existing boundary and token gates stay on.

Workspace chrome/settings and the shared
composers/picker are implemented. Chat is the built-in launch default. No prototype-only catalogs,
capabilities, permissions or context counters are production facts. The scoped model catalog and
shared visibility contract is implemented for pi/OpenCode; initial thinking remains unavailable.
See [Model catalogs](model-catalog.md) for the policy and adapter limits.

## Target flow (stages A and B built)

What a user does. Everything below is built and verified end to end, chat views and the handoff included. Keys listed here are the effective defaults.

1. `prefix t` opens the new-task view in the main area (`layout.md`, **New task view**): a prompt field, plus project (current), agent · model, workspace and view, all prefilled from settings and changeable from the keyboard. Enter submits.
2. The task appears in the sidebar at once under the prompt-derived seed title, which the generated title replaces. Its primary agent opens in the chosen view, already working on the prompt. No shell opens on its own.
3. Inside a task (header and tab strip: `layout.md`), sessions are equal tabs: agents (terminal or chat) and shells. `prefix c` adds a shell, `prefix s` another agent, `prefix n`/`p` or `prefix 1`–`9` switch tabs. Chat is a tab kind, not a separate mode or a bottom panel. `prefix shift+c` opens the task's `Changes` tab after the sessions: what the task changed, and — under the summary row — staging, a commit message and commit, then push and create-pull-request behind one confirmation each, with no number hint and no status glyph; opening it leaves the current session where it was — the arrow keys in the strip keep moving between sessions, and choosing a session tab returns to it.
4. `prefix v` hands the current agent session over between chat and terminal: one frontend is
   stopped and its process waited for, then the other starts on the same agent conversation, so
   the session keeps its name, its tab and its history. An idle agent switches at once; a working
   one asks first, because the handoff ends that turn — aborted in chat, cut when a terminal's PTY
   closes — and a request the agent is waiting on is cancelled with the frontend. The confirmation
   names both, per direction, together with what survives (the conversation the agent already wrote). While the switch runs, the main area says "Switching this session to …" instead
   of showing a half-switched pane. Only an agent with a chat driver has two views: the palette
   shows the action disabled with the reason for a shell or a driverless agent, and pressing the key
   there shows the same reason instead. A handoff whose second start fails leaves the session stopped
   in the target view with the launch error and its Restart button, and `prefix v` on a stopped
   session only chooses the view its next start opens in. An agent whose driver keeps both views
   live (OpenCode)
   does not hand over at all: `prefix v` opens the other frontend beside the running one, nothing is
   aborted, and the palette says "Open the … view" instead of "Switch to …", so no confirmation is
   asked for a busy agent (stage C). Whether Codex's terminal is view-only while chat writes is
   measured when its driver starts.
5. The sidebar groups tasks by project by default, or flat by status (Needs you, Working and Done); both use one bottom settled shelf; `prefix l` toggles the mode and the device keeps its choice. A task's status is the most urgent of its sessions', ordered: needs approval or input, error, working, completed and unseen, idle. "Completed and unseen" clears when the task is opened or its status changes while it is selected. A project row expands or collapses its group, and its row menu offers New task and Remove project…; a project with no tasks shows its composer (from Add project, its New task action or its URL), never a loose terminal.
6. `prefix f` finds a task, `prefix j`/`k` steps through tasks, `prefix e` renames the task (session rename stays `prefix shift+r`), `prefix d` settles.
7. Settings carry the defaults the composer uses: view (global, overridable per project), workspace mode, worktree root, branch prefix, slug mode, naming agent/model; and the agents, whether each is found and which have a chat driver.

## Layout and navigation

- Three places: the sidebar of tasks, the main area's task header and session tabs, and the
  session below them (`layout.md`). The sidebar is a fixed pane the user resizes; the terminal
  takes the rest of the main area. There is no title bar of our own and no global status bar.
- The sidebar lists tasks only. A wordmark header has the sidebar toggle opposite it; the next
  row has Search, grouping and New task. Its footer carries Settings, Add project, the prefix
  hint while disarmed, and the shell status: connection state, config problems, the armed-prefix
  badge and the current failure. When the sidebar is hidden the same status sits in a strip above
  the main content, so hiding the pane cannot remove it; only the visible placement is mounted,
  so no live region or connection opener is duplicated, and that strip keeps its row, so arming
  the prefix does not resize the terminal under it. The sidebar has a default and a narrow-window
  width, dragged between its limits with the edge handle, leaving the main area its minimum at and
  above the supported 1024 px floor — kept per device, reset by a double click, and hidden or shown
  by `prefix \`. `prefix w` gives the list the keyboard, showing the sidebar first if it was
  hidden: arrows walk its rows, Enter opens one, and Escape returns the keyboard to where it came
  from.
- Project grouping is the default (`prefix l` switches to status groups and the device keeps
  the choice). The bottom Settled shelf spans projects with one order in both modes
  (`layout.md`, **Sidebar**), scrolls independently and pages by the rows its box fits; selecting
  older history reveals it without resuming it. Rows are two-line tasks;
  selection uses secondary appearance plus `aria-current` on exactly one task or loose terminal;
  a project or Scratch container row never carries it, and no row is current while a project's
  composer is open — not a bespoke colored left bar. Titles and paths truncate without losing
  accessible names: a row names its title, attention word or age, second line and unseen mark,
  and its status message is the description and a tooltip line. Change counts and a linked
  request sit in a non-shrinking tail that keeps normal values whole at the narrow width;
  container names carry their counts, a clipped project row names its absolute path, and an
  exited loose terminal names its code. A focused row keeps focus and its ring across a sidebar
  resize. Loose terminals sit in the Scratch section, one line each, and only while some exist.
- The main area has two separate rows: repository/task header, then session tabs with a
  Chat/Terminal switch and add-session menu. A draft also keeps both rows. Tabs may sit above
  or below content (device preference). A tab shows its number, real tool logo or a working,
  blocked or failed status glyph, and its name; right-click or Shift+F10 opens stop/restart,
  rename and remove. No space is reserved for invisible actions. `prefix 1`–`9` and `prefix n`/`p`
  still select.
  After the sessions, a `Changes` tab holds the task's changed files and finishes the task
  (`layout.md`, **Changes**): stage, commit, push to the named remote and open a pull request
  through the user's own `gh`/`glab`, every remote write confirmed by name and URL. While it is
  open the current session keeps its place in the strip and a `+N −M` count sits in the task header
  and the sidebar row when the task changed something; a linked pull request's name and state sit
  beside the count, and a merged one offers settle in the `Changes` finish bar.
- The main area never goes blank: with no task selected it is the new-task composer, prefilled
  with the current project; a project with no tasks opens its composer, never a loose terminal.
  A project composer and the sidebar read one value: no row is current. A composer opened over a
  selection opens its project's group, and Escape leaves it for the selection the URL still names;
  a URL that names a zero-task project is itself the composer state, so its group follows the
  collapse state and Escape has no earlier selection to return to. The composer has no URL of its
  own and no draft row in the sidebar. `prefix t` shows the composer over the selected task and
  Escape returns to that task, with the keyboard back in its terminal.
  Until the projects, tasks,
  sessions and terminals lists have each delivered once, the main area says it is loading; a
  list the server refuses is one muted line naming that list with a Retry, never the first-run
  form.
- Clicking navigation, tabs or the task header must not take the keyboard from the terminal; a
  dialog returns focus to its opener and, failing that, to the terminal (see **Focus, keyboard
  and errors**).
- Secondary task/session actions use context menus and the palette; the task header keeps a
  discoverable overflow menu, and the tab row keeps its add-session menu; renaming a session keeps `prefix shift+r`, removing it
  asks first. Icons are Lucide's standard glyphs.
- One scrolling region per pane. At 1024×640 and above all controls must be reachable. Long
  forms may scroll inside the stock dialog with a viewport-relative height cap; do not
  shrink/reposition stock controls to recreate the former density.

## Tasks, sessions and sources

- Add project is a path dialog with inline errors. New task is the composer view in the main
  area (`layout.md`, **New task view**), not a form dialog: a prompt and shared agent/model,
  Chat/Terminal and Create row, then project/workspace setup prefilled from effective settings.
  Optional title stays; issue import expands only through the Task setup actions menu. Enter creates the task and starts its primary agent with the
  prompt as its launch argument; a task created from the optional title alone starts no session,
  so it stays empty until a shell or an agent is added. Project changes clear project-specific
  import and branch state safely; issue import feeds the composer's prompt (the issue's title and
  link) and keeps its source snapshot as the task's title context.
- Ordinary radio groups retain the kit default. The shared model picker owns its compact
  tool/profile icon rail; modules do not invent selectable cards or control skins.
- Remove task keeps [the confirmation for local content](design.md#domain-model); keyed buttons
  prevent a single Enter from confirming both stages. No branches are deleted implicitly.
- Remove project is a project row's destructive action: its confirmation names the project and,
  when it has any, how many tasks it forgets (a zero-task project is named without a count), and
  says the worktrees and branches stay on disk. A project with a
  task whose terminal runs is refused and nothing changes; Cancel and Escape return the keyboard
  to the row. Because the removed project named the selection, the main area lands on the
  resolver's fallback — the URL, the Changes tab and the composer follow it — never on a blank one.
- Rename is a focused dialog, the same one for a task's title, a session label and a loose
  terminal label. Every loose terminal row offers it, not only the current one, and naming a row
  does not select it. Enter closes the dialog before the save; a failed save is a workspace
  notice, not a reopened dialog. Session labels persist; loose terminal labels survive only for
  their terminal's lifetime. The historical first-character risk remains unexplained; changing kits
  is not evidence of a fix.
- An exited loose terminal also offers Restart: a new terminal with the same command, arguments,
  folder and label at the current size, selected, and the dead row closed. A restart the server
  refuses leaves the dead row and its label and shows the failure; the exit badge and the pane's
  exit line stay until then.
- Imported source is immutable original title/body/link context, displayed as escaped
  text. Pending/cancel/project-switch guards and manual-title preservation remain.

## Focus, keyboard and errors

- Dialogs capture their opener, suspend prefix handling and restore the connected
  opener, with the active chat/task composer or terminal textarea as fallback. Keyboard-opened dialogs
  capture the current target rather than reusing a previous pointer opener. The connection-recovery
  dialog puts its capability field first; Enter submits and Escape closes it.
- First input receives focus; destructive confirmation starts on Cancel. Escape and
  outside interaction use Base UI behavior; destructive outside clicks do not close.
- Menus, dialogs, popups and the palette keep the shared focus ring and the declared enter
  transition, but close immediately: a closing popup must not hold the keyboard, so
  no exit animation delays its unmount. Tests then assert one live popup or the
  terminal's first character instead of waiting for a transition. The prefix never
  handles keys while a task dialog is open.
- The terminal behaves like a terminal: Tab, Shift+Tab, Escape, F6 and Ctrl+Tab belong to the PTY,
  so navigation does not take them. `prefix w` is the keyboard's way out of it and works whatever
  has the keyboard — the terminal, chat, a composer or a stopped session. It focuses the current
  task row, else the list's first row, else Add project in the footer; arrows and Home/End walk
  the rows; Enter opens a row and hands the keyboard back to that task's terminal, chat or
  composer; Escape returns it to the field or terminal the list took it from. Shift+F10 on a row
  still opens its task menu.
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
  Connection and protocol-mismatch notices remain app-level, not transient success toasts. A page
  that cannot use the server — no capability, a stored pair for another server, a malformed
  capability, an invalid `?server=`, a server that cannot be reached at startup, a protocol
  mismatch, or a refused capability — shows one framed notice with the cause in one sentence and
  only the actions the host has. Boot failures with a usable address offer a capability field and
  Reload; an invalid `?server=` offers only Reload — fix the address, then reload, because a
  capability cannot repair it. An unreachable server offers Retry. A protocol mismatch offers
  Reload in a browser and tells desktop to stop that server and start the app again (the server
  outlives a quit). A refused capability offers the field and, on desktop, the same restart hint.
  While the workspace is running, the connection status names `attempt N` and the elapsed time
  and opens the same capability field as a dialog; submitting writes it into the hash the client
  re-reads before every attempt, and one recovery entry point retries the RPC connection and every
  attached terminal, so the task, tab, draft and terminal survive and a refused terminal reattaches
  with the new capability. Nothing behind a boot notice was mounted, so the notice never sits over
  an empty workspace. A workspace failure is one status row: a failed action keeps its sentence
  until the next navigation or selection, guidance that asked for a project or task uses the same
  row, and either can be dismissed.
- Chat keeps the composer semantics of the new-task view: Enter sends, Shift+Enter is a newline,
  and while a turn runs Enter steers and Ctrl/Cmd+Enter queues a follow-up where the driver
  declares one (the composer says which). Without that declaration both keys steer, Queue is
  absent, and the hint names only steer and abort. `prefix .` aborts the working turn and the
  palette lists the same action. While an abort is pending the control says it is stopping,
  whether the button, `prefix .` or the palette started it.
- The chat control row shows the driver-reported model and thinking level. Either opens the
  same tool/profile → model → thinking picker; `prefix m` / `prefix shift+m` and palette actions
  open it too. Type filters real models; Ctrl/Meta+1–9 selects visible offered rows. A model
  applies without closing; old thinking levels disappear until that model is reported. Choosing
  thinking applies and closes. A refused choice stays open with its error. Another tool/profile
  starts a distinct session, never mutates the current launch or moves its unsent draft.
  Before launch the picker offers native/configured defaults, supported native model IDs and
  reported pi/OpenCode catalogs, never a stock catalog or invented thinking levels. Discovery does
  not imply the adapter can select every entry; incompatible rows explain their disabled state.
  Manage models opens a server-shared per-tool/profile allow/deny draft in Settings. Hiding a
  current selection never changes it, and favorites cannot bypass the filter. A terminal session
  has no live model control.
- The composer's view control offers `terminal` always and `chat` only for an agent
  `chat.capabilities` reports a driver for. A `[tasks] view = "chat"` (or a project's) that names
  an agent without a driver is reported as a config warning and opens in the terminal; when the
  user picks such an agent in the composer the view control moves to `terminal` and says why. A user request
  arrives as the last timeline item with the keyboard: arrows and Enter answer `select` and
  `confirm`, Enter answers `input`, Ctrl/Cmd+Enter answers `editor`, and Escape dismisses any of
  them. Prefix mode is the window capture-phase handler, so it works while the composer, the chat
  and the terminal have the keyboard; plain keys stay in the field, and Tab, Shift+Tab, Escape, F6
  and Ctrl+Tab stay in the PTY (see **Focus, keyboard and errors**). The transcript is a focusable `log`: PageUp/PageDown,
  Home/End and the arrow keys scroll it without a pointer; moving up releases the end follow and
  End takes it again. A fold that expands while the user reads above the end does not drag the
  view back to the tail.

### Local links in chat

- A path an agent writes in an answer is actionable when the task's workspace actually holds it:
  absolute paths, workspace-relative paths and `file.ts:12[:3]` are recognised, and the server
  resolves them through the workspace (`files.resolve`) — a `..` path, an absolute path elsewhere,
  a symlink out of the workspace and a path that does not exist all stay plain text rather than
  becoming a dead link. Code spans and fenced blocks are never linkified. A `..` after a symlink is
  read lexically (`link/../x` is `x` beside `link`), as `path.resolve` does, not as a shell would.
- A path is an **action, not a URL**: it is drawn like a link but it is a button, so ctrl/cmd-click
  does not open a meaningless tab and "copy link" offers no `#corral-file…` token. It opens in the
  editor: `[editor] command`, else `$VISUAL`, else `$EDITOR` (`agent-profiles.md`, **The editor for
  local file links**), run as a terminal in the task's workspace, which is then selected. The line
  and column the message named travel only through a `{line}`/`{column}` placeholder. A refusal
  (nothing configured, the executable is missing) is a sentence above the composer, not silence.
- Images and videos in the workspace preview inline, bounded by size and type (4 MB images,
  8 MB video). The preview is a button: Enter or Space opens a lightbox, Escape closes it, and the
  video plays there. While the bytes travel the lane holds the preview's height, so a screenshot
  does not push what is being read down the page. Every failure is **one row with an Open button
  that names the file**: too large for the bound, a refused read, bytes that do not decode (a
  `.png` that is not an image, a broken video) — never a broken frame or a stuck "Loading". Any
  other file, binary or not, is the same action that opens the editor.
- An **explicit Markdown link** is the same rule, not an exception: `[label](/etc/passwd)`,
  `[label](src/app.ts:12)`, a reference link whose definition is a path and a raw HTML anchor all
  become that path, so an inside path opens the editor or previews and an outside one says
  "outside the workspace" in place. A destination the lane does not own — `mailto:`, an in-page
  route, an unknown scheme, a relative destination that is not a file — renders as the label's
  text. **No anchor a chat message produces can navigate the window**: the lane's anchor component
  covers links written as Markdown, reference links and raw HTML alike, and it renders nothing with
  an `href` except an http(s) link it hands to the OS browser or a new tab.
- A server built **before** the file-link procedures (an older daemon on the same protocol)
  answers them with oRPC's "no procedure matched": the lane shows one muted line — "This server
  does not offer file links; restart it after upgrading Corral." — stops asking, and leaves every
  path as the plain text it already was. One line, not one per message.
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
  cannot run now is shown disabled with the reason it cannot (e.g. "The claude agent has no chat
  driver in this build.").
- A new default binding can take a chord an existing `config.toml` gave to another action:
  the file's entry is dropped, that action falls back to its own default, and Settings reports
  the conflict.
- Task search shares cmdk and the watched client task set. Enter inspects a result;
  inspecting settled history does not continue it. Continue is explicit.
- Settings is a large categorized modal over the mounted workspace, so drafts, selection, scroll,
  terminal attachment and focus survive. Background prefix actions and seen marks pause while it
  is open. Device-local Appearance controls tab position and interface text scale. Server settings
  remain read-only: actual config path, effective bindings, problems, profile
  descriptors, the effective task defaults and naming, each project's overrides, and the agents
  (`[agents.<kind>]`: enabled, the command a launch runs, whether it is found, and whether this
  build has a chat driver).
  `config.toml` remains the source of truth; no server-config write controls are added. The Models
  category edits separate SQLite-backed menu preferences, shared across this server’s clients,
  with revision-checked saves and explicit draft discard. It never edits native config.
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
- Interface text scale is adjustable per device (80–140%, relative to OS/browser scale).
  Terminal text stays fixed and independent of the interface text scale; terminal font controls
  are separate scope.
- Hover-only row actions and settings writes are not implied by this kit migration.
  Mid-session model and reasoning switching belongs to a chat driver; a terminal session has no
  such control.
