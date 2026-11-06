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

<!-- UI changes: publish before/after images at 1024×640 and 1920×1080 with
`gh pr create/edit --attach <file>#<label>` (or a PR comment), then put the hosted
`user-attachments` URLs here. Originals live in `.review/<piece>/`; never commit them or use
release assets. Label source SHA, viewport and scale/state, read the body back, and preserve
existing hosted URLs on later edits. Delete this section otherwise. -->

## Docs

<!-- The doc line that describes the changed surface: updated here, or deleted. -->
