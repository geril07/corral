# Delivery and review

How a UI slice travels from brief to merge in the owner-led rebuild (#258).

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

1. **Worker.** Implements the slice, self-verifies, captures evidence, and commits. Self-verification
   means the whole gate: `pnpm check`, the focused browser suites the change can break, format and
   lint of the touched files, and the UI class gate. A worker that cannot run something says so in
   its report; it does not hand unfinished checks to a reviewer. Doc updates for the changed
   behaviour are part of the slice. A UI change also carries before/after screenshots at 100% and
   140% interface text in the PR, captured from the worker's final tree.
2. **Review.** One `reviewer` reads the slice as both product and engineering: does it match the
   reference it claims; hierarchy, spacing, iconography and copy; data shape and ownership, protocol
   and state, design-system reuse, edge cases, test quality, docs versus code. Findings are ordered
   P0–P3; a P0 or P1 goes back to the worker.
3. **Fix and re-evidence.** The worker fixes P0/P1 in the same branch and re-runs only what the
   change invalidates: affected tests, the gate when code or configuration changed, and new
   screenshots when the UI changed. A clean rebase with no code change needs no new evidence.
4. **Merge.** The orchestrator rebases, merges after the owner's visual OK, and records the slice in
   `docs/ui-rebuild.md`.

## Models

Every agent in the loop runs on the same model, and the launch passes it explicitly rather than
relying on an agent default. A subagent that fails on a provider limit is relaunched with the model
named, not silently left out of the pipeline.

## What reviewers run

One reviewer covers both the product and the technical read; there is no second review. The
reviewer does not run the gate and does not run the test suites — that is the worker's evidence, and
a review that reruns it adds nothing. They may:

- read the diff, the tests the worker wrote, and the worker's reported commands and results;
- open the running app read-only to see states;
- write and run a single throwaway test to prove a suspected bug, and report it with the result.

If the worker's evidence is missing, stale (the code changed after it), or does not cover the
change, that is a P1 finding on its own.

## What the orchestrator decides

Scope questions the references answer are decided during the brief. A question that changes the
product (a new user-visible concept, a reversed decision, a destructive path) is asked, not
decided. Between those: ambiguity inside an accepted slice is the orchestrator's call, recorded in
the commit message or the slice report.

## Orchestrator scope

The orchestrator owns the issue and PR bodies, `docs/ui-rebuild.md`, the lane order and the
dependency map. Implementation, screenshots, the gate and the review are delegated to subagents;
the orchestrator does not write code, run suites or capture screenshots itself. It merges after the
owner's visual OK and records the slice in the status doc.
