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

Canonical primitive **defaults and visual classes are unchanged**, including
animations/transitions, button translation, badge shape, dialog placement/width,
focus rings and tooltip treatment. Repository adaptations are relative imports,
Oxfmt formatting, reuse of the existing clsx/tailwind-merge helper instead of the
redundant `cn` package, FieldError's message key and InputGroup's event type guard.

Current structural needs have named kit variants, not module class overrides:

- Button `layout="tree"`: flex allocation, start alignment and truncation for the
  project/task/session hierarchy. Selection uses stock `secondary`, otherwise
  stock `ghost`; no replacement hover, ring, color, height, padding or font rules.
- Badge `layout="truncate"`: bounded flex allocation for a saved launch summary;
  the badge's stock variant, shape and sizing are unchanged.
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
  its default stacked layout. Hint adds optional content, accessible tooltip role
  and Base UI's non-hoverable-popup behavior without changing stock visual classes.
  IconButton uses stock icon size/ghost variant; links use stock button link classes
  on native anchors to preserve link semantics.

Official Sidebar was inspected. Its provider owns a new Ctrl/Cmd+B shortcut,
mobile/collapse state and cookies, so installing that behavior would expand the
product scope. The fixed pane/tree therefore compose stock Buttons instead of
introducing that provider. No custom sidebar control skin is maintained.

Status names plus distinct Lucide glyphs distinguish agent states; colors are
stock `muted-foreground` / `destructive`, not a second palette. xterm resolves the
stock body's foreground/background to sRGB via canvas because its parser does not
support OKLCH; no terminal theme tokens or UI font-size changes are introduced.

## Boundary and tests

Modules may use structural layout and semantic content typography. They must not
set `className`, `style`, color/dimensions or `render` on kit controls, including
field labels, command items and wrappers. Opaque prop spreads are rejected too;
pass behavior props explicitly. Put a demonstrated structural need in a named kit
variant; do not disguise the old skin as a variant. Existing raw-control, import,
palette/arbitrary-value and retired-token gates remain enabled.

Tests wait for completed menu transitions or identify the intended tooltip/action,
not immediate DOM removal. Minimum-viewport form tests assert visible/non-overlapping
stock options and reachable actions; the previous forced-horizontal test was
superseded with the compact-skin requirement. No fix is claimed for the historical
unexplained Rename first-character drop or the baseline font-control gap.
