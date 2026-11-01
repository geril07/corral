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

## Target flow (stages A–B in `design.md`)

What a user does; replaces the form-first flow below as each stage lands. New keys are proposals until implemented; existing ones are unchanged.

1. `prefix t` opens the new-task view in the main area (`layout.md`, **New task view**): a prompt field, plus project (current), agent or profile, model/reasoning, view and workspace, all prefilled from settings and changeable from the keyboard. Enter submits.
2. The task appears in the sidebar at once under the prompt-derived seed title, which the generated title replaces. Its primary agent opens in the chosen view, already working on the prompt. No shell opens on its own.
3. Inside a task (header and tab strip: `layout.md`), sessions are equal tabs: agents (terminal or chat) and shells. `prefix c` adds a shell, `prefix s` another agent, `prefix n`/`p` or `prefix 1`–`9` switch tabs. Chat is a tab kind, not a separate mode or a bottom panel.
4. `prefix v` hands the current agent session over between chat and terminal (stop one frontend, resume the same conversation in the other). OpenCode can keep both live; Codex's terminal is view-only while chat writes.
5. The sidebar lists tasks either flat by status (sections Needs you, Working and Done, plus a settled shelf; the default) or grouped by project; `prefix l` toggles the mode and the device keeps its choice. A task's status is the most urgent of its sessions', ordered: needs approval or input, error, working, completed and unseen, idle. "Completed and unseen" clears when the task is opened or its status changes while it is selected.
6. `prefix f` finds a task, `prefix j`/`k` steps through tasks, `prefix e` renames the task (session rename stays `prefix shift+r`), `prefix d` settles.
7. Settings carry the defaults the composer uses: view (global, overridable per project), workspace mode, worktree root, branch prefix, slug mode, naming agent/model.

## Layout and navigation

- Three places: the sidebar of tasks, the main area's task header and session tabs, and the
  session below them (`layout.md`). The sidebar is a fixed pane the user resizes; the terminal
  takes the rest of the main area. There is no title bar of our own and no global status bar.
- The sidebar lists tasks only. Its 44 px header is task search with its chord plus a new-task
  button; its 36 px footer carries the connection state while it is not connected, the
  prefix-armed pill, config problems and Settings. It is 264 px by default (232 px below
  1180 px), dragged between 208 and 420 px with the edge handle, kept per device, reset by a
  double click, and hidden or shown by `prefix \`.
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

- Add project is a path dialog with inline errors. Current (until A5 replaces it): new task is
  a form with a title, an optional issue import and a workspace; creating from it starts no
  session, so the task stays empty until a shell or an agent is added, and project changes
  clear project-specific import/branch state safely. The task's prompt, agent and prefill
  arrive with the composer; issue import then feeds the composer's prompt and seed title.
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
- Errors stay with the form at `role="alert"`; failed submissions preserve input.
  Connection/protocol mismatch notices remain app-level, not transient success toasts.
- Clicking navigation must not steal terminal focus. Tooltip content is optional;
  it cannot hold the only copy of a fact. Accessible names identify every icon action.
- Status is a named state plus a distinct glyph, with stock semantic theme colors.
  No custom status or terminal palette is added.

## Palette, search and settings

- The palette lists every effective binding in fixed Sessions, Tasks, Projects,
  Navigation and General groups, using official CommandDialog/Command components.
- A new default binding can take a chord an existing `config.toml` gave to another action:
  the file's entry is dropped, that action falls back to its own default, and Settings reports
  the conflict.
- Task search shares cmdk and the watched client task set. Enter inspects a result;
  inspecting settled history does not continue it. Continue is explicit.
- Settings is read-only: actual config path, effective bindings, problems, profile
  descriptors, the effective task defaults and naming, and each project's overrides.
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
  Chat is stage B; mid-session model switching comes with the chat drivers, not the terminal.
