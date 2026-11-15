# Web UI kit

Read this before changing the web or desktop UI. System boundaries are in
[Architecture](architecture.md); verification selection is in [AGENTS.md](../AGENTS.md#verification).

## Direction

The visual shell takes its dark and light baseline from OpenCode's `oc-2` theme; Corral owns its
compact sidebar geometry. T3 is the reference for structure and interaction where a matching
pattern exists. Orca may inform interactions, not a second color or control system.

Semantic color and chrome values live in
[`visual-shell.css`](../apps/web/src/common/ui/visual-shell.css), with its license notice beside
it. Use those roles rather than copying values into modules. Interface text scales per device;
the terminal keeps its own monospace role and does not follow interface text scale.

The supported desktop window starts at 1024×640; smaller layouts have not been decided. The
window floor is in [`apps/desktop/src/main.ts`](../apps/desktop/src/main.ts).

## Boundary

Interactive primitives live in [`common/ui`](../apps/web/src/common/ui/). Modules compose them
and choose named variants; they do not import Base UI, cmdk or icons directly, restyle controls
with class/style overrides, select kit `data-slot` markers, or pass opaque prop spreads. Add a
kit variant for a demonstrated need rather than wrapping a control to bypass its boundary.
Modules own structural layout and semantic content. Keep the UI-boundary lint and
[`check-web-ui.mjs`](../scripts/check-web-ui.mjs) gates enabled.

Base UI owns popup placement, collision handling, dismissal, keyboard navigation and focus
restoration. Preserve the same accessible behavior for custom compositions instead of adding a
parallel document-level popup lifecycle.

## Foundations

- **Focus:** keyboard focus must be visible, including inside scrolling rows and containers.
  Accessible names remain available when visible text truncates. Dismissing a dialog or menu
  returns focus to its opener or the active work surface.
- **Keyboard:** ordinary typing and IME composition belong to the focused input. Terminal keys
  belong to the PTY; the configurable prefix provides a way out. Browser-reserved shortcuts are
  not a promise the web client can keep.
- **Input preservation:** opening Settings must not destroy the mounted workspace, terminal
  attachments or drafts. Failed creation and refused sends retain the user's input.
- **Motion:** no continuously looping animation; respect reduced motion. Do not animate dialog
  geometry when interface scale changes. Popup teardown and focus restoration must remain bounded.
- **Density:** use the kit's semantic type, spacing, radius and control roles rather than
  feature-specific copies. A monospace family is a role, not a font size.
- **Accessibility tradeoff:** the current visual direction intentionally keeps non-text
  hairlines below the 3:1 contrast target. Do not mistake that documented exception for a general
  license to reduce control or text contrast.

The kit owns the actual values and component recipes. A change in placement or a CSS value does
not by itself require a prose inventory update.
