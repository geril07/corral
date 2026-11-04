# Web UI kit

Kind: **Direction (supersedable)** below, then **Boundary (law)** and **Compositions (current
state)**. An approved study that changes the look rewrites Direction in its own PR; it never
edits Boundary without a decision. Compositions follow the code: a PR that changes a control
updates or deletes its line.

## Direction (supersedable)

The current direction is UI study 03, which superseded the stock-only appearance requirement:
quiet dark surfaces, restrained borders, blue actions and focus, readable compact rows and real
tool logos, in the spirit of T3 Code. Keep shadcn/ui Base UI / Nova as the primitive foundation,
not a second visual system. Orca may inform interactions, not colors or another control skin.
This paragraph is the one place a visual reference is named; a new study replaces it.

The theme in `apps/web/src/app/global.css` follows T3 Code's dark neutral palette (MIT): black
canvas, raised neutral surfaces, white low-opacity borders/hover and blue primary. Reuse the
existing semantic tokens.
The installed Geist font, radius derivation and most primitive dimensions remain. Interface text
follows the device scale, and the interface text scale is device-local and rem-based, independent
of the terminal's fixed font.

The previous official shadcn generation commands, provenance and stock-only migration are
archived in [research/shadcn-baseline.md](research/shadcn-baseline.md). They are a baseline for
upstream diffs, not a prohibition on the accepted theme.

## Boundary (law)

All interactive primitives live in `apps/web/src/common/ui`. Modules compose them, never
import Base UI, cmdk or Lucide directly. Keep `scripts/check-web-ui.mjs` and its AST,
raw-control, arbitrary-value, palette and retired-token gates enabled.

A kit control cannot receive `className`, `style`, `render`, color/dimensions or opaque prop
spreads from a module. Add a named variant for a demonstrated need. Modules own plain structural
layout and semantic content typography. Changes belong in the kit rather than wrapper CSS.

Keep Base UI responsible for popup positioning/collisions, dismissal, keyboard navigation,
focus restoration and modal trapping. No hand-written popup lifecycle or document-level
context-menu dispatcher.

## Compositions (current state)

- Button `layout="tree"`: allocation/truncation inside a horizontal task/project row;
  `size="row"`: the two-line task. `layout="navigation"` fills a settings category's width
  without vertically stretching it. `layout="tab"` uses content width up to a maximum.
  `layout="model"` bounds a model trigger so long native IDs really truncate.
- RowMenu composes a real button with Base UI ContextMenu. Right-click, the menu key and
  Shift+F10 reach secondary actions. No permanently reserved invisible action gutter.
  DropdownMenuItem uses the same underlying Base UI menu item in either kind of menu.
- OverflowMenu is the discoverable task-header and add-session menu, with one compact
  minimum width. Menus fit available width/height. Combo search popups default to a readable
  width, not the tiny trigger width, bounded by the available viewport.
- TaskDialog / DestructiveTaskDialog retain remembered opener and workspace-input fallback
  (chat/task composer, then terminal). The named picker layout contains the shared ModelPicker.
  Settings uses the named large, viewport-bounded `layout="settings"`, with its own scrolling
  content and categories. It is a route-backed modal over a mounted workspace, not a page that
  destroys drafts and terminal attachments. Other dialogs keep their existing dimensions.
- Popup exit animations remain removed: keeping closing menus mounted delayed focus and
  swallowed the first character after Escape. RowMenu has no delayed teardown.
- Hint retains Base UI semantics and 300 ms delay. `useTruncatedText` owns clipping measurement
  and middle ellipsis; full labels remain accessible, with a full-name tooltip when clipped.
- AgentIcon owns the four real tool logos and the shell glyph. Source and MIT notice:
  `agent-logos.ts` / `agent-logos.LICENSE`. StatusGlyph still distinguishes states by shape
  and color; its sizes match the tab's tool icon slot.
- AppShell, SidebarPanel, MainPanel, TaskContent and ContentLane own structural layout.
  TaskContent is a size container so a prompt capped at 50cqh fits half the content area,
  excluding the task/session chrome rather than growing to half the entire window. Sidebar sizing is
  device-local; text scale never applies a CSS transform that would confuse popup coordinates.
- ComposerSurface and ComposerToolbar own the shared prompt frame and wrapping control row.
  Textarea `framing="composer"` removes its duplicate inner border without changing prompt/chat
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
