# Goal: stage A — task model on the terminal

Deliver stage A of Corral: a task starts from a prompt, its agent starts working on that prompt, the task gets a generated name and a readable worktree, and the sidebar shows tasks by status or by project. You are the orchestrator of this run; the user is not available for routine questions.

## Read first

1. `AGENTS.md`: commands, commit rules, gotchas.
2. `docs/design.md`: decisions 3, 5, 13–17, **Domain model**, **Stages**. Product truth.
3. `docs/ux.md`: **Target flow** and the rules that stay. `docs/layout.md`: placement and sizes every UI slice follows; its **Review later** list is for the user, do not reopen those choices.
4. `docs/plans/stage-a.md`: the slices, their order, briefs and gates. Your work queue.
5. `docs/roadmap.md` (**Working mode**, **Decision boundaries**) and `docs/progress.md` (baseline, test notes).

## How to run

- Orchestrate; delegate exploration, implementation, review and verification to the matching agent roles, with the model named in `docs/roadmap.md` → **Working mode**. Brief each agent with the slice's section of `docs/plans/stage-a.md`, the relevant decisions, and what to return; point to files by path.
- One slice per branch (`feature/stage-a-<slice>`, e.g. `feature/stage-a-a2-prompt`) in its own worktree under `/home/geril/code/my/corral.worktrees/`. Follow the wave order in the plan; slices of one wave may run in parallel.
- A slice is integrated when its gates in the plan pass, its review (mandatory for A3 and A4, by risk otherwise) has no open P0–P2 finding, and it is rebased onto `main` and fast-forwarded. Integrate one slice at a time; the next rebases onto the result.
- After each integration, update `docs/progress.md` (requirement ledger row: outcome, commit, gate counts, evidence path) and keep evidence under `.e2e/stage-a/<slice>/`.
- When a brief turns out wrong or incomplete against the code, decide within `design.md`'s decisions, correct the brief in `docs/plans/stage-a.md` in the same branch, and note why in the slice's report.

## Boundaries

- Local only: there is no git remote; push nothing, publish nothing.
- No paid model calls in tests or verification: fake agents and a fake naming CLI. Real agent CLIs only for `--help`/`--version`.
- Never write to the user's global agent config (`~/.claude`, `~/.codex`, `~/.pi`, OpenCode's config) or to `~/.config/corral/config.toml`; tests use isolated directories.
- Leave existing branches and worktrees from earlier runs untouched.
- Out of scope: everything under "Not in stage A" in the plan, stage B/C work, appearance changes beyond what a slice needs.

## When blocked

A decision only the user can make (product behavior not settled by `design.md`, a new paid dependency, an external write): record it in `docs/progress.md` under **Open decisions** with the options and your recommendation, then continue with slices that do not depend on it. If every remaining slice depends on open decisions, stop and report.

A failing gate is not a blocker: find the cause. Do not raise timeouts or retry into green without evidence (`docs/progress.md`, test baseline).

## Done when

- Slices A0–A8 are integrated on `main`, each with its ledger row in `docs/progress.md`.
- On final `main`: `pnpm check`, `pnpm test:browser` and `pnpm test:e2e` pass under the pinned Node; counts and logs recorded.
- A-verify (plan, **A-verify**) is PASS by an independent verifier, report at `.e2e/stage-a/verify/report.md` with screenshots at 1920×1080 and 1024×640.
- `docs/ux.md` no longer describes the replaced form-first flow as current; `docs/design.md` reflects any decision the run had to make; `docs/roadmap.md` marks stage A done.
- The final report to the user lists what changed for them, open decisions, and anything verified only with fakes (for example: real agents' handling of the initial prompt beyond `--help`, real naming output quality).
