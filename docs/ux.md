# UX

The client is a compact, graphical desktop app for people who live in terminals; the terminal is one pane inside it, not the frame around it. This is the reference an agent reads before changing layout, chrome or interaction in `apps/web`. Product behavior: `design.md`. Code layout, kit boundaries and tests: `engineering.md`. Paths below are repo-relative; `.refs/` is the reference checkout described at the end.

## Layout and density

- Two panes: a fixed sidebar and a main pane that takes the rest (`apps/web/src/common/ui/layout.tsx:7`). The main pane gives all of its space to the current surface (terminal, stopped-session card, board): no page titles, breadcrumbs or tab strips around it.
- One row per entity. Rows and controls are 28px with 13px text (`apps/web/src/common/ui/button.tsx:22-26`); a secondary action never adds a second line to a row.
- Row actions are icon-only and appear on hover, focus-within, and always on the current row (`.refs/t3code/apps/web/src/components/sidebar/SidebarThreadRow.tsx:1022-1028`). The one row of global actions at the bottom of the sidebar is an icon toolbar, not text buttons (`.refs/orca/src/renderer/src/components/sidebar/SidebarToolbar.tsx:67-85`).
- Persistent prose loses to tooltips. The prefix legend (`apps/web/src/modules/workspace/workspace-screen.tsx:82-88`) becomes a compact prefix chip; the palette lists every binding. An inline key hint stays only in an empty state or beside a disabled action.

## Sidebar

- Hierarchy is project → tasks → sessions. A project is a shelf header at weight 600, with a count and status dot only while collapsed (`.refs/t3code/apps/web/src/components/sidebar/SidebarProjectFolderHeader.tsx:33-37`), never a boxed folder icon.
- Tasks are ordered by status urgency inside a project. Settled tasks sit in a collapsed group with a count (`apps/web/src/modules/workspace/sidebar.tsx:240`), and the group opens while it holds the current task (`sidebar.tsx:210-211`).
- Sessions show under the current task only, one line each, no branch or path (today every task lists its sessions: `sidebar.tsx:130-134`).
- Selection is one project, task or entry at a time, marked by an accent left bar plus `bg-surface-active` and `aria-current`, so it never relies on accent color alone (`apps/web/src/common/ui/tree-row.tsx:4-20`).
- Titles end-truncate; branches middle-truncate so a shared prefix does not eat the row (`.refs/t3code/apps/web/src/components/ui/middle-truncate.tsx:32-48`). Show the full value in a tooltip only when it is clipped (`.refs/orca/src/renderer/src/components/sidebar/truncated-sidebar-label.tsx:76-77`), and keep the row's accessible name the full title.
- One scroll container per pane. Nothing scrolls inside a row or a group.

## Projects and tasks

- Adding a project stays a path dialog with an inline error (`apps/web/src/modules/projects/add-project-dialog.tsx`).
- The project picker is a combobox field in New task, defaulted to the selected project, with "Add project…" as the last item (`apps/web/src/common/ui/combobox.tsx`). A task inherits a project; the picker is a field, not a mode.
- Task actions: settle/unsettle and remove live in a row overflow menu. Remove keeps the confirm with the dirty-worktree second step (`apps/web/src/modules/tasks/remove-task-dialog.tsx:44-75`), whose keyed buttons stop one Enter from confirming twice.
- Session actions: stop/restart is the only inline icon, because it changes state and is frequent; remove is in the overflow. Enter on the current stopped session restarts it (`sidebar.tsx:156-159`).
- Rename is a dialog, not inline row editing: the row overflow and the palette open it, and `Dialog` + `Field` builds it with no new kit part or row-editing state, so Enter stays free for restarting a stopped session (inline alternative: `.refs/orca/src/renderer/src/components/sidebar/WorktreeTitleInlineRename.tsx`). A session label outlives a server restart, which needs a new `label` on `Session` (`packages/protocol/src/rpc.ts:136-163` has none today); a loose terminal keeps its label only for that terminal's lifetime, and the dialog says so.

## Icons, tooltips, accessible names

- Icon set: `lucide-react`, imported per icon, 14px in a 16px box; both references use it. Keep inline SVG only where the shape is the meaning, as with status glyphs (`apps/web/src/common/ui/status-glyph.tsx:20-24`). Replace the text glyphs `▾ ▴ × ■ ▶`.
- Every icon-only control has an `aria-label` (verb + object, e.g. "Stop claude session"), a tooltip with the same words plus the binding, and a 28px hit area. The icon itself is `aria-hidden`.
- Tooltip delay is 300ms (`apps/web/src/common/ui/tooltip.tsx:22`), one popup per trigger. A tooltip never holds the only copy of a fact: the same words are in the accessible name.
- Tabbing follows visual order, focus opens the tooltip, and every icon-only action also appears in the palette, so nothing depends on hover or on a tooltip alone.
- Status is shape plus color, named by `role="img"` and the tooltip (`apps/web/src/modules/status/status-indicator.tsx:6-20`).
- Focus is always visible: 2px `focus-ring` outline with 1px offset (`button.tsx:6`). Never drop an outline without an in-place replacement.

## Dialogs, focus, errors

- A dialog is a task, not a page: open while rendered, Escape and backdrop close, `ConfirmDialog` for anything destructive with no backdrop close (`apps/web/src/common/ui/dialog.tsx:28-65`).
- Focus returns to the element that opened the dialog, falling back to the xterm helper textarea when that element is gone (`.refs/orca/src/renderer/src/components/cmd-j/palette-focus-restore-target.ts:1-15`). Today every close goes to the terminal (`dialog.tsx:6-9`); fix this before adding dialogs.
- The first field takes focus on open, and a destructive confirm starts on Cancel (`remove-task-dialog.tsx:44-57`).
- A failed submit keeps the dialog open with its input intact and the message at `role="alert"` (`dialog.tsx:71-73`); no toast. Connection loss and protocol mismatch are the only app-level banners (`apps/web/src/modules/connection/connection-notice.tsx:6-19`).
- Clicking the sidebar must not take focus from the terminal (`sidebar.tsx:205`); the prefix keymap is suspended while a dialog or the palette is open.

## Empty states

- An empty state says what is missing, offers one primary action and one key hint; an empty palette result is one short line and never offers an implicit create. No illustration, no explanation of the feature.
- No projects: the footer action adds one and the main pane repeats that action, not the product pitch. A task with no sessions names both ways to start one (`workspace-screen.tsx:112-118`); a stopped session keeps its reason and a primary restart (`apps/web/src/modules/sessions/stopped-session.tsx:12-25`); the board is one line (`apps/web/src/modules/board/board.tsx:53`).

## Palette, search and history

- One palette (Cmd/Ctrl+K) with one input and three result kinds: actions with their binding, tasks/sessions, projects. Groups stay fixed: Sessions, Tasks, Projects, Navigation, General. Recents lead a group, excluding the current task (`.refs/t3code/apps/web/src/components/CommandPalette.tsx:810-820`).
- Search runs over the client's `tasks.watch`, which already carries active and settled tasks (`packages/protocol/src/rpc.ts:222-224`): no `tasks.search`, no second index, no separate find dialog. A settled result is labeled settled and reopens through the existing settle lifecycle on selection; a deleted task is gone from the watch and stays gone, never resurrected from a client cache.
- Matching covers task title, branch, project, session label, action label and binding; ranking is cmdk's (`mvp5/web`: `apps/web/src/common/ui/command-palette.tsx`, `apps/web/src/modules/keymap/command-palette.tsx`).
- Enter runs or jumps, Escape closes leaving the selection alone, arrows move, the input keeps focus. A sub-choice (project path, task's project) opens as an intent page inside the same dialog (`.refs/t3code/apps/web/src/components/CommandPalette.tsx:248-269`; `.refs/t3code/apps/web/src/components/ui/command.tsx:66`).
- History is client-side: the last 10 visited task and session targets, dropped when the task or project disappears.

## Settings and profiles

- One settings route with a flat left nav: Keys, Agents, Projects, Config. The nav becomes an icon rail below 1024px (`.refs/t3code/apps/web/src/components/settings/SettingsSidebarNav.tsx:144`).
- Keys lists the effective binding per action and the config path. An invalid entry shows in the existing problems dialog with its path (`mvp5/web`: `apps/web/src/modules/keymap/config-problems.tsx`), while the rest of the file still applies.
- `config.toml` is the source of truth until a write API exists; settings is read-only until then and says so once, in the section header, not in a banner.
- Profile and model choice hang off the agent picker: pick the agent, then the model only when a profile exists. Defaults per agent kind live in Settings → Agents. A launch carries only `AgentKind` today (`packages/protocol/src/rpc.ts:109`), so no model UI before the launch carries a profile.
- A model list groups by provider, default first, and stays a single-select list; favorites and hidden lists are out of scope (`.refs/t3code/apps/web/src/components/settings/ProviderModelsSection.tsx:57-70` as density inspiration).

## Visual hierarchy and tokens

- Hierarchy comes from surfaces and weight: `surface` for the app, `surface-raised` for the sidebar and dialogs, `surface-active` for hover and selection. Borders only between panes, at dialog edges and under the sidebar toolbar.
- Type stays at 13px/1.4 body, 12px secondary and `Kbd`, 15px dialog title, weight 600 for project rows and dialog titles. No new sizes.
- Color comes from the theme block (`apps/web/src/app/global.css:9-19`). Palette classes and arbitrary values outside `common/ui` fail the gate (`scripts/check-web-ui.mjs:16`), so a new metric is either an existing token or a kit class.
- Token delta allowed here: at most one `--color-text-subtle` for a third text level, and only once a second component needs it. No spacing, elevation or motion scale.
- Motion is color and opacity only, about 120ms, and status changes must not move a row under the cursor (the board follows the task, `apps/web/src/modules/board/board.tsx:20-23`).

## Responsive minimums

- Supported: two panes at 1024×640 and larger, with a 240px sidebar (`layout.tsx:7`). The sidebar is resizable 220–320px only when a resize handle ships.
- Below 1024px the sidebar is an overlay above the main pane, opened from the palette and closed with Escape. No feature disappears and no row shrinks below its truncation width.
- The terminal keeps at least 80×24 cells; below that the fit addon shrinks the font rather than adding a scrollbar.
- Dialogs clamp to the viewport: 440px wide, 70vh tall (`dialog.tsx:15-16`).

## Implementation sequence

| #   | Change                                                    | Done when                                                                                                                                        |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Icons and tooltips on rows and the footer toolbar         | Every icon-only control has an accessible name; no `▾ × ■ ▶` text nodes; the footer is one 28px row                                              |
| 2   | Truncation: middle-truncated branch, tooltip only clipped | At 240px a 60-character title with a long branch shows no clipped glyphs, and hover or focus reveals both fully                                  |
| 3   | Focus restore for dialogs and the palette                 | Palette opened from a sidebar button returns focus there on Escape; opened from the terminal, it returns to xterm                                |
| 4   | Project combobox in New task                              | A task created from a selection defaults to its project; another project creates the worktree there                                              |
| 5   | Palette results: tasks, sessions, projects, recents       | Typing a task title and pressing Enter selects that task's session; a settled task reopens without a duplicate; recents exclude the current task |
| 6   | Rename dialog for sessions and loose terminals            | After a server restart a renamed session keeps its label; a renamed loose terminal's label disappears with the terminal, as the dialog warned    |
| 7   | Settings route: sections, read-only keys, config problems | A bad config entry shows its path and message in Settings while the app keeps working                                                            |
| 8   | Visual pass: glyphs to icons, weight hierarchy, borders   | `pnpm check` and `pnpm test:browser` pass; `global.css` holds no token beyond the allowed delta                                                  |

## Unresolved

- Sessions under the current task only (this document) or under every task (today). Take current-task-only; revisit if it slows task switching.
- Destructive actions in an overflow menu or as a permanent row icon; the overflow costs mouse users one click.
- Hover-revealed actions on touch and low-precision pointers. No decision yet, and a breakpoint is not enough without a touch target rule.
- Sidebar below 1024px: overlay (this document) or an icon rail (the settings-nav pattern).
- Whether settings should write `config.toml` through the server; the protocol has no write path.
- The per-session model override surface (a second step in the agent picker or a session menu) once launches carry a profile; defaults per agent kind are settled.
- The board as a route (`apps/web/src/routes/board.tsx`) or an overlay on the workspace.
- `lucide-react` as a dependency or a local icon module, if a new dependency is unwanted.

## References

Checked out at `/home/geril/code/my/playtest/.refs`; paths are relative to it.

| Reference      | License    | Stance                                                                                                                                                                                                |
| -------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.refs/t3code` | MIT        | Adopted: shelf headers, middle truncation, palette groups and recents, dialog input focus. Inspired: settings depth, empty-state layout.                                                              |
| `.refs/orca`   | MIT        | Adopted: icon toolbar with tooltips, tooltip-only-when-clipped, focus restore. Inspired: kanban, tabs, per-project overrides.                                                                         |
| `.refs/herdr`  | Apache-2.0 | Adopted for the rename shape only, a modal prompt rather than inline row editing (`.refs/herdr/src/client/shell/overlay_input.rs:410-430`). Its terminal-style chrome is what this document replaces. |

Patterns are adopted, no code is copied. `lucide-react` is ISC and adopted for icons if the dependency is approved (verified from npm metadata); MIT and ISC permit either course.
