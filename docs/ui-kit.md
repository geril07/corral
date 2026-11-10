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
and motion rules.

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
  file list). `layout="navigation"` fills a settings category's width without vertically
  stretching it. `layout="tab"` fills the tabstrip's height and uses content width up to a
  maximum. `layout="model"` bounds a model trigger so long native IDs really truncate.
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
  DropdownMenuItem uses the same underlying Base UI menu item in either kind of menu.
- OverflowMenu is the discoverable task-header and add-session menu, with one compact
  minimum width. Menus fit available width/height. Combo search popups default to a readable
  width, not the tiny trigger width, bounded by the available viewport.
- TaskDialog / DestructiveTaskDialog retain the remembered opener, or the explicit final-focus
  target its caller passes, and the workspace-input fallback (chat/task composer, then terminal).
  The named picker layout contains the shared ModelPicker.
  Settings uses the named large, viewport-bounded `layout="settings"`, with its own scrolling
  content and categories. It is a route-backed modal over a mounted workspace, not a page that
  destroys drafts and terminal attachments. The board is a full-screen route layer over the same
  parent, not a dialog: no scrim, and its close returns the keyboard through the same fallback.
  Other dialogs keep their existing dimensions.
- Enter only; the reason is in Direction (**Motion**). RowMenu has no delayed teardown.
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
  layout. MeasuredBox is a scrolling block with a maximum height the caller measured (the Settled
  shelf's one page); a raw inline style stays in the kit.
  TaskContent is a size container so a prompt capped at 50cqh fits half the content area,
  excluding the task/session chrome rather than growing to half the entire window. Sidebar sizing is
  device-local; text scale never applies a CSS transform that would confuse popup coordinates.
- The workspace route now composes `VisualShellView`: a borderless 320 px (100–640) sidebar over
  `bg-deep`, an 8 px inset `bg-base` main surface with radius 10, a 40 px Corral header, the
  Search/New-task row, a flat 52 px task card list and a footer. `VisualTaskCard` keeps its title
  metrics in every state, swaps the fixed 88 px status slot for the Settle action on hover/focus,
  and opens its metadata tooltip on hover and keyboard focus: title, then icon+value rows for
  project, branch and the primary agent's known model/provider, with no workspace path or ordinary
  status row. `VisualIconButton`, `VisualSearchAction`, `VisualResizeHandle`, the compact
  tooltip/keycaps and the metadata tooltip are the only controls the shell composes.
- One root-layer toggle owns hide/show. It reads the sidebar's real width and the reserved header
  and main-chrome slots, so the 240 ms width transition is the only motion; there is never a
  second visible or tabbable toggle at either endpoint or in flight.
- Unavailable shell actions stay focusable with `aria-disabled` and explain the reason in the
  compact tooltip; they never use an empty click handler. Add project opens the existing real
  dialog; Search, New task, Settings and Settle are deferred in this slice.
- The workspace status slot follows the task's **primary** session only; auxiliary terminals do
  not contribute agent status, unread state or sort priority. Working shows no duration because
  `AgentStatus.updatedAt` is a report time, not a run start.
- Settings, the board, chat, changes and the terminal panes still use the prior kit compositions
  until their own rebuild; their controls do not become the source of new visual rules.
- ComposerSurface and ComposerToolbar own the shared prompt frame and wrapping control row. The
  frame shows the shared focus ring while focus is inside it.
  Textarea `frame="composer"` removes its duplicate inner border without changing prompt/chat
  growth limits. ModelPicker owns the Base UI popover, radio rail, cmdk model list and vertical
  thinking toolbar; modules supply driver/config data and actions, not control skins.
- Checkbox composes Base UI checked/mixed state using the shared primary/input/focus tokens.
  ModelPicker can suspend its popup for Settings while retaining its search and selection owner.
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
