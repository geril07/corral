# Roadmap / backlog

Working queue from the user's backlog. The user authorizes autonomous, context-supported product improvements after this queue is exhausted. Adjust ordering from evidence, not novelty.
Product decisions remain in [design.md](design.md); technical constraints in [engineering.md](engineering.md).
Execution status and verification evidence: [progress.md](progress.md).

## Working mode

- Parent agent orchestrates: scope, decisions, Markdown handoffs, branches and integration.
- Delegate code exploration, external research, implementation and verification to the matching agent role.
- All delegated roles, including reviewers, use `opencode-go/deepseek-v4.1-flash:high` unless the user changes this.
- Use review where risk warrants it; verify user-visible changes through their real interfaces.
- Keep detailed evidence in task reports; hand off paths and concise findings rather than source dumps.
- Continue through research, scoped implementation and verification without waiting for routine confirmations. Keep decisions and progress on disk.
- Defaults: import issue titles directly; generate short titles from initial prompts only when a suitable configured mechanism exists; begin integration with read-only import/source links.
- Make reversible improvements within the task-centric product and current stack. Defer broad architectural replacement, paid dependencies other than the accepted title-generation call, or external mutations; record the decision needed and continue with other work. Chat follows the writer and approval rules in `design.md` (**Terminal and chat**).
- When the queue runs out, inspect the real UI and end-to-end flows, identify concrete friction against the UX direction, then implement and verify the highest-value bounded slice. Do not manufacture features or refactoring to stay busy.

## Starting point

The MVP and the first backlog (UX baseline, task search and labels, issue import, launch profiles, read-only settings, stock shadcn kit) are built and verified; see `progress.md`. On 2026-10-31 the user reviewed the result against Orca, T3 Code and Herdr and re-set the direction: the task starts from a prompt and gets a generated name, chat and terminal are equal tabs of a task. Decisions: `design.md` (decisions 3, 5, 13–16, **Domain model**, **Stages**); flow and keys: `ux.md` (**Target flow**).

## Sequence

| Stage                         | Result                                                                                                                                                                                                                                                                                                                                                                                   | Gate                                                                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Task model on the terminal | **Done** — integrated `a0`…`a8` on `main`: task-only sidebar, task header and session tabs (`layout.md`); prompt-first new-task view replaces the form; primary agent starts with the prompt; seed and generated titles, optional generated slugs; worktrees at `<root>/<repo>/<slug>`; no automatic shell; rename task; sidebar flat by status or grouped by project; unseen completion | Initial-prompt argument checked against each agent's `--help`; naming failure and timeout leave a usable task with the seed title; existing tasks and worktree paths keep working |
| B. Chat (pi)                  | **Done** — integrated `T0`, `b0`…`b5` on `main`: server-owned chat contract (protocol 9), hand-written pi RPC driver with a supervised child and one persisted writer, keyboard-first chat tab (Streamdown + `@pierre/diffs`), `prefix v` handoff, model/reasoning chooser, `[agents]` and `view = "chat"` settings; independently verified (`.e2e/stage-b/verify/report.md`)            | One writer per session enforced by the server; handoff verified to resume the same pi session both ways; approvals routed                                                         |
| C. More drivers and git       | OpenCode (live in both views), Claude Code (stop and resume), then Codex; diff, commit and pull request linked to the task; local file, image and video links in chat                                                                                                                                                                                                                    | Per-agent handoff verified on the pinned version; Codex live-view contradiction resolved (`design.md`, **Terminal and chat**); no remote writes in verification                   |

Stage A is split into slices with briefs in [plans/stage-a.md](plans/stage-a.md); the autonomous run that executed it is kept in [plans/stage-a-run.md](plans/stage-a-run.md). **Stage A is done**: slices A0–A8 are integrated on `main` and independently verified through the real app (`.e2e/stage-a/verify/report.md`); `progress.md` has the ledger, gate counts and the decisions the run made for review. Stages B and C: [plans/stage-b.md](plans/stage-b.md), [plans/stage-c.md](plans/stage-c.md) (C is refined against the B1 driver before it starts); the run that executes them is `goal.md` at the repository root, with its settled decisions. Layout and taste decisions for all three: [layout.md](layout.md).

Appearance was revised on 2026-11-01 in `layout.md` and is built inside the stages (mainly A8); the user polishes after. Mobile is not scheduled; stage B must keep chat state on the server (decision 14).

## UX direction

User requirements:

- Graphical application chrome, not a terminal imitation; compact and uncluttered.
- Every persistent element earns its space. Move secondary explanations into tooltips.
- Icon-first action buttons with tooltips and accessible names; retain meaningful task content and actionable errors.
- Preserve keyboard access, visible focus, dialog dismissal and terminal focus return.
- Task-centric sidebar, flat by status or grouped by project; convenient project addition/selection.
- Coherent settings/configuration surface, not scattered controls.
- Use T3 Code and Orca as references, selectively rather than copying their entire interaction model.

## Decision boundaries

- Titles: prompt-derived generation through a user-configured agent CLI is accepted, including its cost; Corral holds no provider account. Issue titles still seed a task directly.
- Integration: issue import and source links exist. Pull request creation in stage C is a user action; verification never writes to real remotes.
- Chat: no generic OpenAI-compatible history of its own; the agent's native session is the conversation.
- Stack: the current strict stock kit stays; a framework or kit replacement needs a separate decision.
- Sidebar: the flat and project-grouped modes are two views of one task list, not two data models.
