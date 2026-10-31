# UX

Corral is a graphical, keyboard-first workspace for people who live in terminals.
Product behavior: `design.md`. Kit provenance, defaults and boundaries: `ui-kit.md`.
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
Stock primitive defaults remain identifiable and unchanged; see `ui-kit.md`.

## Layout and navigation

- Preserve the two-pane hierarchy: project → task → session, one main terminal,
  board, task search, command palette and settings. No chat, splits or store redesign.
- The sidebar remains a fixed pane; the terminal takes the available main space.
  Rows use stock Buttons with a structural tree layout variant; selection uses
  stock secondary appearance plus `aria-current`, not a bespoke colored left bar.
- Task order is creation order, not status order. Current-task sessions remain open;
  other tasks expand on demand. Titles/paths truncate without losing accessible names.
- Row actions use named icon buttons and menus. Frequent session stop/restart remains
  inline; rename/remove remain menu actions. Icons are Lucide's standard glyphs.
- One scrolling region per pane. At 1024×640 and above all controls must be reachable.
  Long forms may scroll inside the stock dialog with a viewport-relative height cap;
  do not shrink/reposition stock controls to recreate the former density.

## Tasks, sessions and sources

- Add project is a path dialog with inline errors. New task selects a project and
  workspace; project changes clear project-specific import/branch state safely.
- Radio groups retain the stock stacked default. Provider/agent/workspace choices
  use stock fields and labels, not custom selectable cards or row skins.
- Remove task retains the dirty-worktree second confirmation; keyed buttons prevent
  a single Enter from confirming both stages. No branches are deleted implicitly.
- Rename is a focused dialog. Session labels persist; loose terminal labels survive
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
- Menus, dialogs, popups and the palette use their stock focus/transition treatment.
  Tests distinguish active/closed state or wait for transition completion instead of
  stripping animations. The prefix never handles keys while a task dialog is open.
- Errors stay with the form at `role="alert"`; failed submissions preserve input.
  Connection/protocol mismatch notices remain app-level, not transient success toasts.
- Clicking navigation must not steal terminal focus. Tooltip content is optional;
  it cannot hold the only copy of a fact. Accessible names identify every icon action.
- Status is a named state plus a distinct glyph, with stock semantic theme colors.
  No custom status or terminal palette is added.

## Palette, search and settings

- The palette lists every effective binding in fixed Sessions, Tasks, Projects,
  Navigation and General groups, using official CommandDialog/Command components.
- Task search shares cmdk and the watched client task set. Enter inspects a result;
  inspecting settled history does not continue it. Continue is explicit.
- Settings is read-only: actual config path, effective bindings, problems and profile
  descriptors. `config.toml` remains the source of truth; no write controls are added.
- Agent selection offers native defaults, named profiles and supported model overrides.
  Changed/deleted profiles require explicit reselection; no silent fallback. Session
  details describe saved launch snapshots, never resolved environment values.

## Known limits

- Desktop support begins at 1024×640; smaller responsive layouts remain undecided.
- Long values may truncate; names and effective summaries retain their full meaning.
- Font +/-/reset exists in playtest but not Corral. Terminal text remains fixed at
  14px; adding controls is separate scope. UI typography itself is stock shadcn.
- Hover-only row actions, settings writes, chat and mid-session model switching are
  not implied by this kit migration.
