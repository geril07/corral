# UX

The client is a compact, graphical desktop app for people who live in terminals; the terminal is one pane inside it, not the frame around it. This is the reference an agent reads before changing layout, chrome or interaction in `apps/web`. Product behavior: `design.md`. Code layout, kit boundaries and tests: `engineering.md`. Autonomous scope and decisions: `roadmap.md`, with outcomes in `progress.md`.

## Layout and density

- Two panes: a fixed sidebar and a main pane that takes the rest (`apps/web/src/common/ui/layout.tsx:7`). The main pane gives all of its space to the current surface (terminal, stopped-session card, board): no page titles, breadcrumbs or tab strips around it.
- One row per entity. Rows and controls are 28px with 13px text (`apps/web/src/common/ui/button.tsx:22-26`); a secondary action never adds a second line to a row.
- Row actions are icon-only with tooltips. Revealing them on hover or focus is a proposal whose touch and low-precision behavior is undecided; the current row always shows its own actions.
- Persistent prose loses to tooltips. The prefix legend (`apps/web/src/modules/workspace/workspace-screen.tsx:82-88`) becomes a compact prefix chip; the palette and task search carry the bindings. A key hint stays inline only in an empty state.
- Density over decoration: no card borders, shadows or pills wrapped around rows.

## Sidebar

- Hierarchy is project → task → session. A project reads as a shelf header, with a count and status dot only while collapsed (proposal from `.refs/t3code/apps/web/src/components/sidebar/SidebarProjectFolderHeader.tsx:33-37`), never a boxed folder icon.
- Task order is stable: creation order, as today (`apps/server/src/tasks/task-store.ts:19`). A status update never moves a row under the pointer. An explicit status sort is a later option, not a default.
- Sessions sit under their task as compact disclosure: the current task's sessions open, other tasks' sessions expand on demand, so no session becomes unreachable (today every task lists its sessions inline: `apps/web/src/modules/workspace/sidebar.tsx:130-134`).
- Selection is one project, task or entry at a time, marked by a primary left bar plus `bg-accent` and `aria-current`, so it never relies on accent color alone (`apps/web/src/common/ui/tree-row.tsx:4-20`).
- Titles end-truncate; branches middle-truncate so a shared prefix does not eat the row (proposal: `.refs/t3code/apps/web/src/components/ui/middle-truncate.tsx:32-48`). Show a tooltip only when the text is clipped (proposal: `.refs/orca/src/renderer/src/components/sidebar/truncated-sidebar-label.tsx:76-77`), and keep the accessible name the full title.
- One scroll container per pane. Nothing scrolls inside a row or a group.

## Projects and tasks

- Adding a project stays a path dialog with an inline error (`apps/web/src/modules/projects/add-project-dialog.tsx`).
- New task carries a project combobox defaulted to the selected project, with "Add project…" as the last item (`apps/web/src/common/ui/combobox.tsx`). The project is a field, not a mode.
- Task actions live in the row overflow: settle/unsettle, view an imported issue source when present, remove. Remove keeps the confirm with the dirty-worktree second step (`apps/web/src/modules/tasks/remove-task-dialog.tsx`), whose keyed buttons stop one Enter from confirming twice.
- Session actions: stop/restart is the only inline icon because it changes state and is frequent; rename and remove are in the overflow. Enter on the current stopped session restarts it.
- Rename is a dialog, not inline row editing: the row overflow and task search open it, and `Dialog` + `Field` builds it with no row-editing state or new kit part (inline alternative, not adopted: `.refs/orca/src/renderer/src/components/sidebar/WorktreeTitleInlineRename.tsx`; modal prompt shape: `.refs/herdr/src/client/shell/overlay_input.rs:410-430`).
- A session label survives a server restart with the same session identity. A loose terminal keeps its label only for that terminal's lifetime, and the dialog says so.

## Icons, tooltips, accessible names

- Icon set: `lucide-react`, approved as a small standard library and added through `common/ui`, catalog-consistently, by the UI worker; imported per icon, 14px in a 16px box. Keep inline SVG only where the shape is the meaning, as with status glyphs (`apps/web/src/common/ui/status-glyph.tsx:20-24`). Replace the text glyphs `▾ ▴ × ■ ▶`.
- Every icon-only control has an `aria-label` (verb + object, e.g. "Stop claude session"), a tooltip with the same words plus the binding, and a 28px hit area. The icon itself is `aria-hidden`.
- Tooltip delay is 300ms (`apps/web/src/common/ui/tooltip.tsx:22`), one popup per trigger, and a tooltip never holds the only copy of a fact.
- Keyboard: tab order matches visual order, focus opens the tooltip, and every icon action also exists in the palette or task search, so nothing depends on hover or on a tooltip alone.
- Status is shape plus color, named by `role="img"` and the tooltip (`apps/web/src/modules/status/status-indicator.tsx:6-20`).
- Focus is always visible: upstream shadcn `ring`/border focus treatment replaces the former outline. Never drop an outline without an in-place replacement.

## Dialogs, focus, errors

- A dialog is a task, not a page: open while rendered, Escape and backdrop close, `ConfirmDialog` for anything destructive with no backdrop close (`apps/web/src/common/ui/dialog.tsx:28-65`).
- Workspace dialogs open through `openDialog` (`modules/workspace/use-workspace.ts`), which captures the current opener and suspends the prefix keymap. `DialogFocusProvider` / `useDialogFocus` in the kit restore that opener, with the xterm helper textarea as fallback when it is gone. Keyboard-opened dialogs capture their own current target rather than reusing a previous button's target.
- The first field takes focus on open, and a destructive confirm starts on Cancel (`remove-task-dialog.tsx:44-57`).
- A failed submit keeps the dialog open with its input intact and the message at `role="alert"` (`dialog.tsx:71-73`); no toast. Connection loss and protocol mismatch are the only app-level banners (`apps/web/src/modules/connection/connection-notice.tsx:6-19`).
- Clicking the sidebar must not take focus from the terminal (`sidebar.tsx:205`); the prefix keymap is suspended while a dialog is open.

## Empty states

- An empty state says what is missing, offers one primary action and one key hint; an empty search result is one short line and never offers an implicit create. No illustration, no explanation of the feature.
- No projects: the footer action adds one and the main pane repeats that action, not the product pitch. A task with no sessions names both ways to start one (`workspace-screen.tsx:112-118`); a stopped session keeps its reason and a primary restart (`apps/web/src/modules/sessions/stopped-session.tsx:12-25`); the board is one line (`apps/web/src/modules/board/board.tsx:53`).

## Command palette and task search

- The palette opens with the configured chord, default `alt+a` then `Space` (`mvp5/web`: `packages/protocol/src/config.ts`, `DEFAULT_BINDINGS`), and every binding shown is the effective one from config.
- The palette lists every action with its current binding, in fixed groups: Sessions, Tasks, Projects, Navigation, General (`mvp5/web`: `apps/web/src/modules/keymap/command-palette.tsx`).
- Task search (the `find-task` slice) is its own focused dialog, sharing the kit's cmdk primitives and the action table rather than a second search framework. Typing searches the client's `tasks.watch`, which carries active and settled tasks (`packages/protocol/src/rpc.ts:222-224`): no `tasks.search` RPC, no second index, no cache that outlives the watch.
- Opening a settled result inspects it in its existing workspace and session context and leaves it settled. Continue is a separate, explicit action that runs the existing settle lifecycle; inspection never mutates state.
- Recents are an optional later improvement, not required persistence. Matching covers title, branch, project and session label; a deleted task leaves the watch and never returns.

## Settings and profiles

- Settings is a read-only route (`apps/web/src/modules/settings/settings-screen.tsx`): show the actual config path, effective bindings, config problems and launch-profile descriptors. `config.toml` remains the source of truth; no write controls are offered.
- The agent picker offers native defaults, named profiles and model overrides where the installed agent supports them. A changed or deleted selected profile requires explicit reselection; never silently fall back to another launch.
- Running and stopped sessions describe their saved launch snapshot, not the current profile definition. Show environment reference names only, never resolved values. Supported agent capabilities and limits: `agent-profiles.md`.

## Visual hierarchy and tokens

- The kit is official shadcn/ui Base UI / Nova, adapted for this compact composition, not a page redesign. Provenance and adaptations: `ui-kit.md`.
- Hierarchy comes from surfaces and weight: `background` for the app, `sidebar`/`card` for supporting surfaces, `popover` for overlays and `accent` for hover/selection. Borders only between panes, at dialog edges and under the sidebar toolbar.
- Type stays at 13px/1.4 body, 12px secondary and `Kbd`, 15px dialog title, weight 600 for project rows and dialog titles. No new sizes.
- Color comes from shadcn semantic CSS-variable pairs in `apps/web/src/app/global.css`, with dark overrides and a derived radius scale. Palette classes, arbitrary values and retired theme utilities outside `common/ui` fail the gate (`scripts/web-ui-classes.mjs`). New metrics belong to the kit; status and terminal colors remain domain extensions. No additional spacing, elevation or motion scale is introduced.
- Motion is color and opacity only, about 120ms. A status update may change a glyph, never a row's position.

## Desktop minimums

- Desktop-first: two panes at 1024×640 and larger, with a 240px sidebar (`layout.tsx:7`). No resize handle, overlay or icon rail until a measured need exists; those remain candidates, not decisions.
- At the minimum, controls stay usable: dialogs clamp to the viewport (440px wide, 70vh tall, `dialog.tsx:15-16`), labels truncate, and the sidebar footer wraps instead of overflowing.
- The terminal keeps the user's configured font size and fits the available viewport with the fit addon; a smaller window shows fewer cells.

## Implementation sequence

| #   | Change                                         | Done when                                                                                                                                                                                                                    |
| --- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Icons, tooltips and keyboard reachability      | Every icon-only control has an accessible name; no `▾ × ■ ▶` text nodes; tab focus opens tooltips; the footer is one 28px row                                                                                                |
| 2   | Stable rows and compact session disclosure     | A status change never reorders rows; other tasks' sessions are reachable by expanding their task                                                                                                                             |
| 3   | Focus restore for dialogs, palette and search  | Palette or search opened from a sidebar button returns focus there on Escape; opened from the terminal, it returns to xterm                                                                                                  |
| 4   | Project combobox in New task                   | A task created from a selection defaults to its project; choosing another project creates the worktree there                                                                                                                 |
| 5   | Palette binding and focused task search        | The configured chord (default `alt+a`, `Space`) opens the palette with current bindings; typing a title finds active and settled tasks; Enter inspects without mutation, and Continue is the only search action that resumes |
| 6   | Rename dialog for sessions and loose terminals | A renamed session keeps its label after a server restart; a renamed loose terminal's label disappears with the terminal, as the dialog warned                                                                                |
| 7   | Read-only settings surface                     | A bad config entry shows its path and message while the app keeps working; no write attempt is offered                                                                                                                       |
| 8   | Visual pass: glyphs to icons, weight, borders  | `pnpm check` under Node 26.13.0 and `pnpm test:browser` pass; `global.css` uses the documented shadcn token convention and domain extensions                                                                                 |

## Unresolved

- Hover-revealed row actions on touch and low-precision pointers; a proposal to settle with the implementation.
- A settings write path, which needs a server write RPC and its own design.
- Model discovery, mid-session model switching, direct provider APIs and account isolation; none is implied by launch profiles.
- Layouts below the desktop minimum (overlay, icon rail, resizable sidebar): candidates only after a measured need.
- The board as a route (`apps/web/src/routes/board.tsx`) or an overlay on the workspace.

## References

Checked out at `/home/geril/code/my/playtest/.refs`; paths are relative to it. Patterns inform decisions; no code is copied.

| Reference      | License    | Stance                                                                                                                                                                                        |
| -------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.refs/t3code` | MIT        | Inspired: shelf header counts, middle truncation, palette grouping, settings nav. Not adopted: settings depth, empty-state layout.                                                            |
| `.refs/orca`   | MIT        | Inspired: tooltip-only-when-clipped, focus restore. Not adopted: inline row rename, kanban, tabs, per-project overrides.                                                                      |
| `.refs/herdr`  | Apache-2.0 | Adopted: the rename shape, a modal prompt rather than inline row editing (`.refs/herdr/src/client/shell/overlay_input.rs:410-430`). Its terminal-style chrome is what this document replaces. |
| `lucide-react` | ISC        | Adopted for icons through `common/ui` if added catalog-consistently; verified from npm metadata.                                                                                              |
