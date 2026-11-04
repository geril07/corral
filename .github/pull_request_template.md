Closes #

## What and why

<!-- One paragraph: what changes, and the issue that decided it. -->

## Checks run

Per `AGENTS.md` **Verification**: what this change can break, not the whole pipeline. Say what ran
and what did not, and why.

- [ ] `vp check` — format and lint
- [ ] `pnpm typecheck` — the packages the diff touches
- [ ] Node tests for the modules changed
- [ ] `pnpm test:browser` — a web surface changed
- [ ] `pnpm test:e2e` — a user-visible flow changed

## Screenshots

<!-- UI changes: before/after at 1024×640 and 1920×1080. Delete this section otherwise. -->

## Docs

<!-- The doc line that describes the changed surface: updated here, or deleted. -->
