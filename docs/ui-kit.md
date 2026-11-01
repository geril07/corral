# Web UI kit

Use **stock shadcn/ui defaults throughout the app**. Keeping the former compact
skin is explicitly superseded: no Corral color tokens, custom body/type scale,
radius scale, control corners, hover/focus treatments or primitive sizing.

## Official default and provenance

Verified with **shadcn 4.23.0**, Node **26.13.0**, pnpm **12.16.1**.
`init --help` identifies `base-nova` as the default preset. A clean official Vite
scaffold was actually generated with:

```sh
mise exec node@26.13.0 -- pnpm dlx shadcn@4.23.0 init --base base --preset nova --template vite --name canonical --no-monorepo --cwd .e2e/shadcn-stock --yes
mise exec node@26.13.0 -- pnpm dlx shadcn@4.23.0 add button badge input kbd dialog alert-dialog dropdown-menu combobox command radio-group tooltip field sidebar scroll-area -c .e2e/shadcn-stock/canonical --overwrite --yes
mise exec node@26.13.0 -- pnpm dlx shadcn@4.23.0 add item alert -c .e2e/shadcn-stock/canonical --overwrite --yes
```

The canonical scaffold's `src/index.css` supplies **all** light/dark tokens,
neutral chart colors, radius derivation, Geist font and base rules, unchanged.
The app starts dark, without adding a theme toggle. Only application host/xterm
height rules and dark `color-scheme` are appended. `shadcn/tailwind.css` is vendored
unchanged apart from formatting as `common/ui/shadcn.css`; `tw-animate-css` and
`@fontsource-variable/geist` are installed locally as the official scaffold does.
No old palette, status/terminal color extension or custom typography token remains.

Sources: [CLI](https://ui.shadcn.com/docs/cli),
[theming](https://ui.shadcn.com/docs/theming),
[Base components](https://ui.shadcn.com/docs/components/base/button),
[registry](https://ui.shadcn.com/r/styles/base-nova/button.json),
[MIT license](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md).
Registry URLs follow `https://ui.shadcn.com/r/styles/base-nova/<name>.json`.
The installed canonical source is frozen locally in `.e2e/shadcn-stock/canonical`;
help/init/add logs, raw registry JSON/hashes, `registry-comparison.json` and
`source-diff.patch` live alongside it. The comparison normalizes only imports and
formatting before producing a full source diff, and independently checks every
stock class expression plus canonical theme/support CSS equality.
Existing React, Base UI, cmdk, Lucide and Tailwind versions are not upgraded.
Interactive primitives import Base UI, not Radix; Command is the official cmdk
composition. Registry dependencies include input-group, textarea, label, separator.

For updates, use the same config (`apps/web/components.json`) and pinned CLI's
`add <component> --diff` before applying changes. Do not restore old visual deltas.

## Permitted adaptations

Canonical primitive **static classes, tokens and enter animations are unchanged**,
including button translation, badge shape, dialog placement/width, focus rings and
tooltip treatment. Repository adaptations are relative imports, Oxfmt formatting,
reuse of the existing clsx/tailwind-merge helper instead of the redundant `cn`
package, FieldError's message key and InputGroup's event type guard.

**Exit animations are removed on purpose** in `dialog.tsx`, `alert-dialog.tsx`
(overlay and content), `dropdown-menu.tsx` (content and sub-content),
`combobox.tsx` and `tooltip.tsx`: no `data-closed:animate-out`/`fade-out`/`zoom-out`
classes, no `duration-*` transition duration and no menu `data-closed:overflow-hidden`
that paired with its zoom-out. Base UI keeps a closing popup
mounted, and returns focus only when it unmounts, until that animation ends; the
~100 ms window swallowed the first character typed after Escape and left two live
menus when the next row's menu opened. Enter animations stay stock, including their
100 ms via tw-animate-css's `animation-duration-100` (it sets an animation duration,
not a transition duration). Closing during a running enter animation still waits for
that animation, which is the remaining bound on teardown.

Current structural needs have named kit variants, not module class overrides:

- Button `layout="tree"`: flex allocation, start alignment and truncation for the
  project/task/session hierarchy. Selection uses stock `secondary`, otherwise
  stock `ghost`; no replacement hover, ring, color, height, padding or font rules.
- Button `size="row"`: the two-line 52 px task row of `layout.md` **Sidebar** needs a
  minimum height and vertical padding above the stock `h-8`; font, radius, color,
  variants and hover/focus treatment stay stock.
- Button `layout="tab"`: a session tab takes its content width up to 200 px and then
  truncates (`layout.md`, **Session tabs**); the tab's own appearance is stock `secondary`
  when selected and stock `ghost` otherwise. The tab strip is composed from this Button with
  `role="tab"`/`aria-selected` in a `role="tablist"`, not from a Tabs component: Base UI's
  Tabs trigger cannot host the strip's sibling stop, menu and close controls, and
  `layout.md` asks for content-width tabs, not the kit's equal-width triggers. No stock Tabs
  class strings are hand-written.
- Badge `layout="truncate"`: bounded flex allocation for a saved launch summary;
  the badge's stock variant, shape and sizing are unchanged.
- Textarea `layout="prompt"`: the new-task composer's prompt has a four-line minimum and grows to
  half the view (`layout.md`, **New task view**). Font, padding, border, radius and focus treatment
  stay stock; only the field's bounds are named, because a module may not size a kit control.
- Textarea `layout="chat"`: the chat composer rests at two lines (`min-h-14` over the stock
  padding), grows to 13 rem and then scrolls (`layout.md`, **Chat**). Font, padding, border, radius
  and focus treatment stay stock; the same bounds serve a request's `editor` answer.
- Markdown: Streamdown 2.7.1 wrapped in `common/ui/streamdown.tsx` with its own UI off
  (`controls={false}`, `linkSafety` off, `animated={false}`, `lineNumbers={false}`) and its code
  plugin backed by `@pierre/diffs`' `getSharedHighlighter`, so code blocks and diffs share one
  engine and the `pierre-light`/`pierre-dark` theme pair. The two Streamdown caps are explicit:
  code blocks at 400 px and tables at 300 px, each scrolling inside itself. `streamdown/styles.css`
  is imported and `app/global.css` carries the `@source` line; the B3 build greps a Streamdown-only
  utility out of the built CSS to prove the pnpm symlink is followed. Modules pass `text` and
  `streaming`, no classes. Streaming Markdown replaces T3's `ChatMarkdown.tsx` (goal D1).
- DiffView: `@pierre/diffs`' `PatchDiff` in `common/ui/diff-view.tsx`, unified, wrapping in the
  46 rem lane, no file header (the tool row names the path), the pierre theme chosen from the
  document's `dark` class, no worker pool. More than 20 unified content lines fold at exactly 20
  line boxes (a 408 px cap: 20 × 20 px plus the code surface's 8 px top padding) behind "Show all
  N lines" (`layout.md`, **Chat**); content lines are counted through `@pierre/diffs`' parser, so
  file and hunk headers, the trailing newline and repeated headers in a multi-file patch are not
  counted. Modules pass the diff text and optional path.
- Combobox `ComboboxButton` / `ComboboxSearch`: the composer's row of compact pickers is a stock
  combobox trigger rendered as an outline `Button` showing its value, with the list's search field
  (Base UI's input-inside-popup pattern) inside the popup. The kit owns the `render` composition
  because modules may not pass `render` or `className` to a control; the trigger's stock variants,
  shape and focus ring are unchanged, and the popup keeps the stock enter animation and the
  removed exit animation.
- ContentLane: the centered 46 rem content lane of `layout.md` (**New task view**, and the chat
  lane in stage B). It is structural like `MainPanel`: modules own the vertical placement and the
  spacing around it, nothing about its appearance.
- DialogContent `padding="none"`: the content box keeps no stock `p-4`, so
  DialogFooter drops its `-mx-4 -mb-4` cancellation and pads itself. Without it the
  stock footer overflows an unpadded content box by 16 px on three sides and is
  clipped. `CommandDialog` (and therefore `TaskCommandDialog`) selects it; the footer
  learns about the padding through kit context, not from the module.
- OverflowMenu keeps `min-w-44`: stock menu content is as narrow as its icon-only
  trigger (`min-w-32`) and "Remove session…" wrapped in the row overflow menu. It takes the
  trigger's glyph and tooltip so the tab strip's trailing "+" is the same stock menu.
- AppShell takes the sidebar's width (including 0 while it is hidden) for its two-column
  grid; the stock 16 rem column remains the default.
- StatusGlyph takes the row (12 px) or chrome (14 px) glyph size of `layout.md` **Status
  visuals** and fades a `done` update the user has already seen to muted. `Icon` carries the
  same `size="row"`/`size="chrome"` steps, so a tab's kind icon and its status glyph stay one
  size and the tab does not shift when a session starts working. `Icon` also carries the chat
  glyph a chat-view session tab shows instead of its agent glyph (`layout.md`, **Session tabs**).
- BoardRow uses exported official Item variants for its appearance and focus,
  retaining only the board's five-column grid as structural layout. Issue text
  and dirty-file lists use stock outlined Item containers; terminal notices use
  stock Alert/AlertDescription rather than hand-styled banners.
- TaskDialog / DestructiveTaskDialog compose official headers, content and footers
  with captured opener/terminal-fallback restoration. A viewport-relative max-height
  and scrolling keep long forms reachable; stock position/width/corners are untouched.
- TaskCommandDialog uses official CommandDialog. Its only upstream API addition
  forwards `finalFocus` to DialogContent; no visual default changes.
- FormField connects a generated id to stock Field/FieldLabel. RadioChoice composes
  stock horizontal Field, RadioGroupItem and FieldLabel; RadioGroup itself retains
  its default stacked layout. Hint adds optional content, accessible tooltip role,
  Base UI's non-hoverable-popup behavior and a 300 ms hover delay without changing
  stock visual classes. The delay is behavioural: every Hint owns its provider inside
  a row-dense sidebar, so the stock 0 ms opens a tooltip the moment the pointer
  crosses a row. IconButton uses stock icon size/ghost variant; links use stock button
  link classes on native anchors to preserve link semantics.
- TaskDialog forwards `showCloseButton` to DialogContent. The issue-source dialog
  keeps one "Close" (its footer action) instead of adding the stock X.

Official Sidebar was inspected. Its provider owns a new Ctrl/Cmd+B shortcut,
mobile/collapse state and cookies, so installing that behavior would expand the
product scope. The fixed pane/tree therefore compose stock Buttons instead of
introducing that provider. No custom sidebar control skin is maintained.

Status names plus distinct Lucide glyphs distinguish agent states, and three status
colors make a list scannable (`layout.md`, **Status visuals**). The one deliberate theme
addition is `--status-working` (blue), `--status-attention` (amber) and `--status-done`
(green), defined for dark and light next to the stock tokens in
`apps/web/src/app/global.css` and exposed as `--color-status-*` utilities. `error` keeps
the stock `destructive` and `idle` the stock `muted-foreground`; no other palette,
status or terminal token is added. The tokens are named only inside `common/ui`
(`StatusGlyph`), never in a module: the retired-token gate still rejects
`bg-/text-status-*` class names outside the kit. xterm resolves the stock body's
foreground/background to sRGB via canvas because its parser does not support OKLCH; no
terminal theme tokens or UI font-size changes are introduced.

## Boundary and tests

`scripts/web-ui-classes.mjs` enforces one rule on kit **controls**: no `className`,
`style`, color/dimensions, `render` or opaque prop spread on a component imported
from `common/ui`, whether it arrives directly, aliased, through a namespace, through
namespace destructuring or through `createElement`/`cloneElement`. That covers field
labels, command items and wrappers; pass behavior props explicitly, and put a
demonstrated control need in a named kit variant rather than disguising the old skin
as one.

Modules still own plain elements. Structural layout (flex/grid, sizing, overflow),
borders, spacing and semantic content typography (`text-muted-foreground`,
`font-semibold`, heading sizes) are allowed there and used by `board.tsx`,
`settings-screen.tsx`, `config-problems.tsx` and the sidebar's row spans. Existing
raw-control, import, palette/arbitrary-value and retired-token gates remain enabled.

Tests assert the DOM without waiting for exit transitions: the row-menu probe asserts
exactly one open menu after the next row's trigger is used, the icon test asserts a
single tooltip, and the Escape probe types the terminal's first character into the
same keyboard call. Minimum-viewport form tests assert visible/non-overlapping stock
options and reachable actions; the previous forced-horizontal test was superseded
with the compact-skin requirement. No fix is claimed for the historical unexplained
Rename first-character drop or the baseline font-control gap.
