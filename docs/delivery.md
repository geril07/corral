# Delivery and review

How one UI change travels from brief to merge. This is the process for the interface rebuild that
started with the OpenCode reference; the earlier full-interface sweep in `.review/` is legacy and is
not the model to copy.

## Reference rule

A pattern that exists in T3 or OpenCode is taken from there: T3 for structure, geometry and
behaviour, OpenCode for the visual language. A pattern that exists in neither is a proposal, not a
default, and the review below judges it as new work. Copying follows the provenance rule in
`docs/design.md`; a port of significant source or assets is a separate licensing decision.

User-visible copy is part of the pattern: do not invent labels, descriptions, empty states or
hints. If no reference has the wording and the state is not a functional error, say so instead of
writing a sentence.

## Pipeline

A slice runs the same way every time.

1. **Worker.** Implements the slice, self-verifies, and commits. Self-verification means the whole
   gate: `pnpm check`, the focused browser suites the change can break, format and lint of the
   touched files, and the UI class gate. A worker that cannot run something says so in its report;
   it does not hand unfinished checks to a reviewer. Doc updates for the changed behaviour are part
   of the slice.
2. **UI/UX review.** A `reviewer` reads the slice as a product: does it match the reference it
   claims, is the hierarchy, spacing, iconography and copy consistent, does every state look and
   behave right, is anything invented that a reference would have answered. Findings are ordered
   P0–P3; a P0 or P1 goes back to the worker before the next step.
3. **Technical review.** A second `reviewer` reads the same change as engineering: data shape and
   ownership, protocol and state, design-system reuse instead of one-off control skins, edge cases,
   test quality, docs versus code. Same output: P0–P3, P0/P1 fixed before merge.
4. **Merge.** The orchestrator rebases onto the feature branch, runs the gate once more on the
   combined tree, and opens the running app for the owner.

Reviews run per slice. Different slices may be reviewed in parallel; within a slice the two reviews
are sequential, so the technical reviewer reads the UI-accepted version.

## What reviewers run

Reviewers do not run the gate and do not run test suites — that is the worker's evidence, and a
review that reruns it adds nothing. They may:

- read the diff, the tests the worker wrote, and the worker's reported commands and results;
- open the running app read-only to see states and capture screenshots;
- write and run a single throwaway test to prove a suspected bug, and report it with the result.

If the worker's evidence is missing or does not cover the change, that is a P1 finding on its own.

## What the orchestrator decides

Scope questions the references answer are decided during the brief. A question that changes the
product (a new user-visible concept, a reversed decision, a destructive path) is asked, not
decided. Between those: ambiguity inside an accepted slice is the orchestrator's call, recorded in
the commit message or the slice report.
