# Web UI kit

Corral uses official shadcn/ui **Base UI / Nova** (`base-nova`), neutral base,
Lucide icons and CSS-variable tokens. Nova's 28px `sm`/`icon-sm` controls fit the
existing desktop density. This is not a shadcn page-layout or Sidebar migration:
the project → task → session tree, fixed 240px sidebar and terminal remain domain
compositions. The app remains dark; a light token set is defined, not exposed as a
new setting. System sans/monospace fonts and 13px body typography are retained.

## Provenance and regeneration

Verified against the live official registry with **shadcn 4.23.0**, Node **26.13.0**
and pnpm **12.16.1**. Existing dependencies remain unchanged: Base UI **1.9.0**,
cmdk **1.1.1**, React **19.3.1**, Lucide **1.65.0**, Tailwind **4.3.3**.

- [CLI](https://ui.shadcn.com/docs/cli): `init --base base --preset nova` is the
  supported fresh-project selection; existing Corral uses `apps/web/components.json`
  rather than scaffolding another application.
- [Base button](https://ui.shadcn.com/docs/components/base/button),
  [Base dialog](https://ui.shadcn.com/docs/components/base/dialog),
  [theming](https://ui.shadcn.com/docs/theming).
- Registry source: `https://ui.shadcn.com/r/styles/base-nova/<name>.json`
  ([upstream MIT license](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md)).
  Each JSON contains the upstream source and documentation links. Interactive
  primitives import `@base-ui/react`, not Radix. Command uses cmdk, which is also
  shadcn's implementation; its transitive dependencies do not change that choice.

From the repository root (overwrites local component adaptations):

```sh
mise exec node@26.13.0 -- pnpm dlx shadcn@4.23.0 --help
mise exec node@26.13.0 -- pnpm dlx shadcn@4.23.0 init --help
mise exec node@26.13.0 -- pnpm dlx shadcn@4.23.0 view https://ui.shadcn.com/r/styles/base-nova/button.json
mise exec node@26.13.0 -- pnpm dlx shadcn@4.23.0 add button badge input kbd dialog alert-dialog dropdown-menu combobox command radio-group tooltip field -c apps/web --overwrite --yes
```

The CLI also installs `input-group`, `textarea`, `label` and `separator` as registry
dependencies. Imports are normalized to relative `.tsx` paths and the existing
`../lib/cn.ts`, and Oxfmt formats the output. CLI 4.23.0 emits a `cn` package import;
Corral removes that redundant dependency and retains its clsx/tailwind-merge helper.
The official `eject -c apps/web --yes` command inlined `shadcn/tailwind.css`; that
output lives in `common/ui/shadcn.css`, avoiding a runtime/CLI dependency solely for
CSS. `add <component> --diff` supersedes the deprecated `diff` command. Review its
output before overwriting adaptations.

Local generation evidence: `.e2e/shadcn/` contains CLI help, `add.log`, `eject.log`,
registry JSON and SHA-256 hashes, exact installed versions and verification logs.
The registry is mutable; retain these snapshots when reviewing a future update.

## Component mapping

| Former kit                    | Official source / current composition                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Button / custom variants      | Button; `primary` → `default`, old default → `outline`, `danger` → `destructive`, muted ghost → `ghost`             |
| Badge, Input, Kbd, RadioGroup | Corresponding upstream components; badges use `secondary` / `destructive`                                           |
| Dialog / ConfirmDialog        | Dialog / AlertDialog; `TaskDialog` / `DestructiveTaskDialog` compose titles, errors and captured-opener restoration |
| OverflowMenu / MenuItem       | Named row trigger composition / DropdownMenuItem                                                                    |
| Combobox namespace            | Combobox, ComboboxInput, ComboboxContent, ComboboxList, ComboboxItem, ComboboxEmpty                                 |
| CommandPalette namespace      | Command, CommandInput/List/Group/Item/Empty                                                                         |
| Field                         | FieldLabel wrapping the existing labelled control                                                                   |
| Tooltip                       | TooltipProvider/Trigger/Content, composed as optional `Hint`                                                        |

No old primitive implementation is kept alongside the upstream replacements.
Task-dialog focus memory, optional hints, row action triggers, tree/board/layout
and status glyphs are app compositions, not alternative primitive kits.

## Intentional adaptations

- Dialogs keep 440px width, 20vh top, 70vh inner scrolling and viewport clamping;
  no default close button, page footer or roomy grid. Titles remain 15px/600.
- Remove overlay entrance/exit/slide/zoom animations **and durations**. A duration
  alone retained closed menu DOM long enough for the next menu to coexist (caught
  by the existing sidebar browser test). Immediate teardown preserves focus/input
  timing. Buttons also keep color-only transitions without upstream's active 1px
  translation. No fix is claimed for the historical unexplained Rename character drop.
- Tooltip content explicitly has `role="tooltip"`; content and positioner are
  click-through and above dialogs. Keep 300ms delay and optional empty-content
  handling. Upstream's contrasting tooltip surface is retained.
- Badges keep compact 18px height, 4px horizontal padding and non-pill corners.
  Buttons retain upstream variants/sizing. Project/branch inputs fill their fields;
  item spacing/check indicators now come from upstream, not module class overrides.
- Two repository lint corrections: FieldError keys use deduplicated message text;
  InputGroupAddon narrows the event target with `instanceof HTMLElement`.
- `background/foreground`, `card`, `popover`, `muted`, `accent`, `primary`,
  `destructive`, `border`, `input`, `ring`, sidebar pairs and the derived radius
  scale replace the former surface/text/danger tokens. `accent` now means an
  interactive surface, **not blue ink**. Primary actions use the readable blue
  `#58a6ff` with dark foreground; destructive actions use upstream's tinted variant.
  Existing dark surfaces, selected bars and terminal colors are retained.
- Status and terminal colors remain domain extensions. Terminal variables are
  ordinary root variables, not prunable Tailwind utilities: xterm reads them from
  computed style. No terminal sizing or stream lifecycle change is included.

UI-boundary lint and raw/arbitrary-color gates remain active. The class gate also
rejects retired semantic token utilities, preventing silent unstyled consumers.
