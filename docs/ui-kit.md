# Web UI kit

Kind: **Direction (supersedable)** below, then **Boundary (law)** and **Compositions (current
state)**. An approved study that changes the look rewrites Direction in its own PR; it never
edits Boundary without a decision. Compositions follow the code: a PR that changes a control
updates or deletes its line.

## Direction (supersedable)

The current direction is the visual shell study, which superseded UI study 03: OpenCode's bundled
`oc-2` theme is the dark and light baseline, Corral supplies its own compact sidebar geometry, and
the whole workspace is being rebuilt rather than restyled. Keep shadcn/ui Base UI / Nova as the
primitive foundation, not a second visual system; OpenCode's Solid runtime is not imported. Orca
may inform interactions, not colors or another control skin. This paragraph is the one place a
visual reference is named; a new study replaces it.

The theme lives in `apps/web/src/common/ui/visual-shell.css` as semantic roles: `bg-deep` for the
shell, `bg-base` for the main surface, `bg-layer-01/03` for tooltips and keycaps, text/icon
muted/faint roles, one hover overlay and semantic status colours. The dark values are `oc-2`
(`#080808`, `#161616`, `#242424`/`#3A3A3A`); the light values are its light variant (`#FAFAFA`,
`#FFFFFF`, `#FAFAFA`/`#EEEEEE`). Source and licence notice: `visual-shell.LICENSE`.

The interface font is **Inter Variable** (`@fontsource-variable/inter`, SIL OFL 1.1); the terminal
keeps its separate mono role. Interface text follows the device scale, and the interface text scale
is device-local and rem-based, independent of the terminal's fixed font; primitive dimensions, type,
elevation, motion and focus follow **Spine**.

### Spine

- **Spacing** — Tailwind's spacing unit is the rhythm, steps `0`–`6`; a gutter above 24 px is a
  _derived_ inset (a step plus the control it clears) and lives only in the kit; a raw width
  appears only to compensate a border, to keep a ring or hairline from scaling, or to bound a
  popup. The visual shell's chrome metrics (320 px sidebar, 52 px card, 28 px controls) are
  kit-owned CSS values, never module class literals.
- **Type** — compact text `13/16`, meta `11/16`, chrome wordmark `15/20`, tooltip `11/12`; the
  prior Tailwind `text-xs`/`text-sm`/`text-base` steps remain for screens not yet rebuilt. Weights
  are **440** regular, **530** medium, **670** bold; tracking stays 0 except an uppercase keycap
  label; mono is a role (paths, code, terminal-adjacent), not a size.
- **Radii** — one ladder off `--radius`; `--control-radius` for every box control and free to move
  independently; an inner radius is its shell minus the shell's inset; a badge is a pill.
- **Elevation** — canvas, raised surface, floating popup, dialog with its scrim, and one inverted
  tooltip; a border separates first; only the two floating tiers carry a shadow; surface, border
  and shadow are the primitive's choice and a caller cannot add one.
- **Dialog placement** — settings and small confirmations are centered. Search, project, model and
  history dialogs hang from a fixed top edge, `max(48px, (100dvh - 480px) / 2)`, with
  `max-height: calc(100dvh - 96px)`, so a changing result count changes only the bottom edge and the
  input never moves. Same rule as OpenCode's results-grow-down pickers; T3's palette anchors higher
  at `10vh`.
- **Motion** — two durations by role and one decelerating easing token; only opacity and transform
  animate; nothing loops; both directions are conditional on motion being allowed, so reduced
  motion removes them and transitions still carry their own reduced-motion pair; there is no global
  kill switch. **Dialogs and their scrim also animate out over 200 ms**: Base UI keeps the popup
  mounted only until that animation ends, then removes it and returns focus, so the keyboard is
  held for a bounded 200 ms rather than an open-ended one. Menus and other popups stay enter-only
  (`ux.md`, Focus).
- **Density** — control heights are kit sizes; a control takes the height of the row it sits in; a
  full-width row uses a row size; a tab fills the tabstrip; a chrome band reads the chrome tokens;
  there is no comfort/compact mode.
- **Focus** — one pair and one width, keyboard only: outside the box for a control with room, inset
  for a full-width row in a scroll container, `has-[:focus-visible]` for containers, and the
  base-layer outline for raw DOM focusables.
- **Ownership** — a module names a variant and never a value; the gate keeps class/style/colour/
  dimensions off controls and restricts module class strings to these ramps, and the kit is held to
  the same recipes.
- **Known deviation** — non-text hairlines stay below 1.4.11's 3:1 (both references do the same; the
  direction is "restrained borders").

The previous official shadcn generation commands, provenance and stock-only migration are
archived in [research/shadcn-baseline.md](research/shadcn-baseline.md). They are a baseline for
upstream diffs, not a prohibition on the accepted theme.

## Boundary (law)

All interactive primitives live in `apps/web/src/common/ui`. Modules compose them, never
import Base UI, cmdk or Lucide directly. Keep `scripts/check-web-ui.mjs` and the lint rules for
layer boundaries and raw DOM controls enabled. Its class-string gates cover arbitrary values,
palette, retired tokens, kit props and spreads, and the **Spine** ramps — spacing steps, type,
radius and shadow, the focus ring and motion — and the kit itself answers the type, surface, focus
and motion rules. A module stylesheet may not select on the kit's `data-slot` marker.

A kit control cannot receive `className`, `style`, `render`, color/dimensions or opaque prop
spreads from a module. Add a named variant for a demonstrated need. Modules own plain structural
layout and semantic content typography. Changes belong in the kit rather than wrapper CSS.

Keep Base UI responsible for popup positioning/collisions, dismissal, keyboard navigation,
focus restoration and modal trapping. No hand-written popup lifecycle or document-level
context-menu dispatcher.

## Compositions (current state)

- PathPicker composes Base UI's inline Autocomplete inside the picker TaskDialog: free input,
  no automatic highlight, library-owned virtual focus and folder rows. Ctrl+N/P route to its arrow
  navigation. The input's trailing Add action shows the current submit shortcut (Enter without a
  highlighted folder, Ctrl+Enter with one) and preserves input focus on pointer submission.
  Its narrow Toast adapter uses Base UI's lifecycle and announcement, without a new
  global notification system. Modules supply server paths and actions, never control skins.

- Button `layout="tree"`: allocation/truncation inside a horizontal task/project row;
  `size="row"`: the two-line task; `size="row-sm"`: a dense single-line list row (the Changes
  file list). `layout="navigation"` fills a compact rail row's width without vertically stretching
  it (the model editor's provider rail). `layout="category"` is the settings category row: 32 px,
  8 px radius, 10 px inline padding, a muted 14/20 label that takes the hover overlay, and the
  current section on `bg-layer-03`. `layout="result"` is a settings search result row, and
  `layout="picker-row"` a settings card list row. `layout="tab"` fills the tabstrip's height and
  uses content width up to a maximum. `layout="model"` bounds a model trigger so long native IDs
  really truncate.
- Button `layout="status"` keeps the footer's connection opener in its row; the visible label is
  the connection state word, shortened when the row cannot hold it, and the sentence with attempt
  and elapsed is its `Hint` and the recovery dialog. It opens that dialog.
- Alert `size="compact"`: the message keeps its own width in a chrome row; a sentence that does
  not fit wraps and the status surface grows for it, so the row's dismiss control sits beside the
  message rather than at the surface's far edge.
- Badge `size="compact"`: the armed-prefix chord in the footer and the hidden strip; the chord,
  not a word, keeps the row's hint and status inside the sidebar at 140 % interface scale.
- RowMenu composes a real button with Base UI ContextMenu. Right-click, the menu key and
  Shift+F10 reach secondary actions. No permanently reserved invisible action gutter.
  DropdownMenuItem uses the same underlying Base UI menu item in either kind of menu, and takes its
  glyph from the kit's `IconName` set; a menu's shortcut cell is a `DropdownMenuShortcut`, hidden
  from the accessible name because the item's label is the action.
- OverflowMenu is the discoverable task-header and add-session menu, with one compact
  minimum width. Menus fit available width/height. Combo search popups default to a readable
  width, not the tiny trigger width, bounded by the available viewport; `layout="anchor"` is the
  opt-in for a select row that opens at its trigger's width, and it survives portalling because the
  kit popup owns it rather than a descendant rule.
- TaskDialog / DestructiveTaskDialog retain the remembered opener, or the explicit final-focus
  target its caller passes, and the workspace-input fallback (chat/task composer, then terminal).
  The named picker layout contains the shared ModelPicker and the project picker: a search field
  over one local autocomplete list, `No project` first, then pinned projects, then the rest; the
  trailing pin action is revealed on row hover or keyboard focus within a reserved slot, and there
  is no header close button (Escape and outside press still close). The project picker has no empty
  state: `No project` alone is the list when nothing else matches.
  Settings uses the named large, viewport-bounded `layout="settings"`: T3's 80 × 60 rem cap,
  inset 24 px from the viewport (40 px at lg), with one content scroller and a 240 px settings
  sidebar. Its type takes the shared rem roles (15/20 title, 13/16 label, 11/16 meta), so the
  interface text scale moves it with the controls instead of leaving it fixed. It is a route-backed
  modal over a mounted workspace, not a page that destroys drafts and terminal attachments. The
  board is a full-screen route layer over the same parent, not a dialog: no scrim, and its close
  returns the keyboard through the same fallback. Other dialogs keep their existing dimensions.
- Settings composes the settings-only primitives in `modules/settings`: a 240 px grouped sidebar
  whose category rows are the kit's `layout="category"` (32 px, 8 px radius, 10 px inline padding,
  16 px icon, 8 px icon-text gap; 16 px group gap, 4 px item gap, 12 px muted group headings), a
  borderless 32 px search row that takes the hover overlay and holds the kit's `frame="bare"` field
  (the caret is its focus indicator), one 720 px content page inline-padded 40 px (24 px narrow), a
  15/20 semibold section title with one line of 13/20 muted description, and 8 px cards on
  `bg-layer-01` with a muted border, 16 px inline padding, and rows separated by 0.5 px dividers.
  There is no settings header row: the content repeats the active sidebar label and the dialog's X
  closes, so there are no breadcrumbs and no separate back action. Projects are file-owned and
  read-only: a picker list of `layout="picker-row"` rows, then one project's resolved task settings
  with `inherited` / `project` source labels, reached from a project row's `Project settings…`.
  Two-option rows use the kit combobox as a select, its trigger stretched to the module's own box;
  a ranged row uses `Slider` with the value box and a reset action beside the label.
- Settings search indexes rows, not prose: each entry is `{id, title, section, aliases}` and only
  the title, section label and authored aliases are fields. Ranking is exact title, title prefix,
  title substring, all query tokens in the title, then a phrase in any field, with declaration order
  as the tiebreak; generated action/profile/agent/project rows are secondary and rank after real
  settings. `/` focuses the borderless 32 px search field unless focus is in a text field or nested popup;
  Escape clears a non-empty query before it reaches the dialog. The arrow keys move the highlight,
  which is painted on the option it belongs to and revealed in the rail as it moves; selecting a
  result switches the section, clears the query, scrolls the row into view, focuses it, and plays
  one motion-safe highlight. Search navigation is local state: it never rewrites the URL or starts
  the discard guard.
- Enter only; the reason is in Direction (**Motion**). RowMenu has no delayed teardown.
- Every native scroller takes the one bar in `app/global.css`, with no opt-in class: an 8 px lane,
  a transparent track inset 4 px at its ends, and a pill thumb inset by its 2 px border. The thumb
  rests low-contrast, so a scrollable column is discoverable without a pointer, and strengthens
  while the scroller is hovered or holds the caret.
- Hint retains Base UI semantics and the shared 300 ms cold delay, and mounts its provider and
  trigger in every state so a clipping flip never remounts the trigger or drops focus.
  `useTruncatedText` owns clipping measurement and middle ellipsis; full labels remain accessible,
  with a full-name tooltip when clipped. A task row's Hint carries the whole row name and its
  status message; a collapsed project row's Hint carries its aggregate attention word and message.
  The same message is the row's `aria-describedby` description.
- All tooltips render through the canonical `Tooltip` family in `common/ui/tooltip.tsx`: it owns
  the Base UI lifecycle, portal, positioning, shared 120 ms entry / 80 ms exit motion, instant warm
  handoff and reduced motion. Compact action, action+explanation and metadata are named
  presentation/content variants; feature code supplies content and placement, not another popup.
  Only the task list is a warm group; chrome tooltips keep the same cold delay independently.
- AgentIcon owns the four real tool logos and the shell glyph. Source and MIT notice:
  `agent-logos.ts` / `agent-logos.LICENSE`. StatusGlyph still distinguishes states by shape
  and color; its sizes match the tab's tool icon slot.
- AppShell, SidebarPanel, MainPanel, TaskContent, ContentLane and MeasuredBox own structural
  layout. MeasuredBox is a scrolling block with a maximum height the caller measured (the prior
  sidebar's one-page Settled shelf); a raw inline style stays in the kit.
  TaskContent is a size container so a prompt capped at 50cqh fits half the content area,
  excluding the task/session chrome rather than growing to half the entire window. Sidebar sizing is
  device-local; text scale never applies a CSS transform that would confuse popup coordinates.
- The workspace route now composes `VisualShellView`: a borderless 320 px (100–640) sidebar over
  `bg-deep`, an 8 px inset `bg-base` main surface with radius 10, a 40 px Corral header, the
  Search/New-task row, a flat 52 px task card list, the Settled shelf and a footer. `VisualTaskCard`
  keeps its title metrics in every state, swaps the fixed 88 px status slot for the settle action on
  hover/focus (settle or unsettle, absent in a host with no task store), and opens its metadata
  tooltip on hover and keyboard focus: title, then icon+value rows for
  project, branch and the primary agent's known model/provider, with no workspace path or ordinary
  status row. `VisualIconButton`, `VisualSearchAction`, `VisualShelfToggle`, `VisualResizeHandle`,
  the dedicated row context menu, the compact tooltip/keycaps and the metadata tooltip are the only
  controls the shell composes. Search and the shelf's disclosure share one wide ghost row recipe,
  `visual-sidebar-row`. A row's menu is the task menu (a Copy submenu of Path, Branch and Task ID,
  then rename, settle or unsettle, source when the task has one, and remove) on the same popup
  RowMenu uses; the visual host
  opts into the shell's floating-surface skin, while the stock kit keeps its own. A copy
  confirmation and a refused task action share the sidebar's notice row above the footer; the
  confirmation clears on the next interaction.
- One root-layer toggle owns hide/show. It reads the sidebar's real width and the reserved header
  and main-chrome slots, so the 240 ms width transition is the only motion; there is never a
  second visible or tabbable toggle at either endpoint or in flight.
- `TaskMain` with `compact` is the working area's **40** px identity row: title, project, branch,
  status and the settled state's word `Settled`, reusing the card's existing strings. The strip's
  band follows it; a bottom strip
  replaces the chrome row rather than adding an empty one.
- `VisualTabStrip` owns the working-area strip: a **40** px band, **28** px tabs (radius **6**,
  inline padding **6**, gap **6**, **16** px glyph, **13/16** weight **530** title), a **20×20**
  close control at inset **4** revealed by hover/focus, a **1.5×12** separator between inactive
  neighbours, a **72** px tab minimum and **24** px edge fades over a horizontal scroller that
  keeps the active tab in view. Numbers are session-tab content inside a group and draft-tab
  content in the draft strip, where the same numbered chords select them; `Changes` and file tabs
  carry none. `VisualTabPanel`, `VisualAddMenu`, `VisualCompanion` and `VisualSplitHandle`
  are the strip's remaining structural pieces: the companion owns a **1** px split with an **8** px
  pointer and keyboard hit area, keeps its contents mounted while shut, and its width and the
  strip's top/bottom position are device preferences. Hover is instant; only the companion's
  width and the edge fades carry motion, both removed under reduced motion.
- Unavailable shell actions stay focusable with `aria-disabled` and explain the reason in the
  compact tooltip; they never use an empty click handler. Add project opens the existing real
  dialog; Search is deferred in this slice.
- The workspace status slot follows the task's **primary** session only; auxiliary terminals do
  not contribute agent status, unread state or sort priority. Working shows no duration because
  `AgentStatus.updatedAt` is a report time, not a run start.
- The board, chat, changes and the terminal panes still use the prior kit compositions until their
  own rebuild; their controls do not become the source of new visual rules.
- ComposerSurface and ComposerToolbar own the shared prompt frame and wrapping control row. The
  caret is the prompt's focus indicator: the frame adds no ring, and the textarea cannot be resized
  by dragging; it grows by its layout limits. Textarea `frame="composer"` removes its duplicate
  inner border without changing prompt/chat growth limits. ModelPicker owns one viewport-bounded
  dialog with three regions — a 44 px
  instance radio rail, a bare search band over the virtualized model list and a 192 px thinking
  column — above a footer shared by all three. The list is flat rows (`provider` heading or model),
  so a heading owns its own height; the thinking levels are a vertical Base UI `Toolbar`. Modules
  supply driver/config data and actions, not control skins.
- **Input padding** is one inline value per control class, measured from both references. A composer
  prompt is 16 px inline and 12 px block: T3's composer body pads `px-4 pt-3.5/4 pb-2`
  (`ChatComposer.tsx:3308`) and OpenCode's editor `ps-4 pt-4 pb-2` (`editor.tsx:321`), so 12 is the
  midpoint of their 16 top and 8 bottom. A one-line input or form textarea is 12 px inline (T3
  11 px plus its border, OpenCode 12 px) and the textarea 6 px block (T3 5 px plus its border,
  OpenCode 6 px). The 40 px search band keeps 12 px inline, like the field it renders; the
  composer's control row keeps its separate 8 px.
- The new-task composer's context row names the project, the workspace and the branch once,
  left-aligned, with no path or summary on the right. The project name opens the shared project
  picker. The workspace is a two-choice picker (`Current checkout`, `New worktree`); a new
  worktree's `from <branch>` opens a popover with a search band over one bordered, scrollable
  branch list. These triggers are borderless plain text with the shared hover.
- Checkbox composes Base UI checked/mixed state using the shared primary/input/focus tokens.
  ModelPicker can suspend its dialog for Settings while retaining its search and selection owner.
- ComboboxButton `layout="bounded"` caps profile/workspace triggers and exposes the
  full text only on measured overflow, so valid long names cannot stretch Settings sideways.
- DialogContent `padding="none"` tells its footer not to cancel nonexistent outer padding.
- BoardRow, ChangeFileRow, DiffPane and DiffView retain their existing behavior. Changes UI
  is not redesigned in this slice.

## Chat rendering

Markdown stays Streamdown, UI off, backed by `@pierre/diffs`' shared highlighter. Code blocks and
tables are capped. DiffView is unified and folds long hunks. The timeline remains virtualized with `@legendapp/list`. No second rendering engine or
provider protocol belongs in the browser.

The prototype's model catalog, context consumption and Full access row are examples only.
Production controls use driver-reported capabilities; launch reasoning/context require explicit
contract work, not mock data or a silently ignored parameter.
