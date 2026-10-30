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
- Make reversible improvements within the task-centric product and current stack. Defer unsupported chat lifecycles, broad architectural replacement, paid dependencies or external mutations; record the decision needed and continue with other work.
- When the queue runs out, inspect the real UI and end-to-end flows, identify concrete friction against the UX direction, then implement and verify the highest-value bounded slice. Do not manufacture features or refactoring to stay busy.

## Starting point

Projects, project-grouped tasks, task branches/worktrees, terminal/agent sessions, settling and resuming tasks already exist. Inventory before adding equivalents.
MVP5 config-driven bindings, command palette and config-problem UI are on `mvp5/web`, pending final verification/integration.

## Proposed sequence

| Order | Track                     | Small useful result                                                          | Gate                                                                                                |
| ----- | ------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1     | UX baseline               | Compact graphical workspace; coherent sidebar, actions, dialogs and settings | Inspect current UI and local references; establish UX rules before applying them                    |
| 2     | Everyday task/session use | Find and continue old tasks; rename terminal/session labels                  | Separate missing behavior from existing settle/resume and project grouping                          |
| 3     | GitHub / GitLab           | Create a task from an issue with source context and a link                   | Agree integration scope and authentication boundary                                                 |
| 4     | Profiles / models         | Configure agent launches, environment and supported model choices            | Distinguish agent-launch profiles from direct API providers; define secret handling                 |
| 5     | Chat                      | Decide whether to add a structured view of existing agent sessions           | Research-supported lifecycle, history and approval ownership; no automatic replacement of terminals |

Slices may be reordered after research. Product-level multi-agent orchestration is outside this backlog.

## UX direction

User requirements:

- Graphical application chrome, not a terminal imitation; compact and uncluttered.
- Every persistent element earns its space. Move secondary explanations into tooltips.
- Icon-first action buttons with tooltips and accessible names; retain meaningful task content and actionable errors.
- Preserve keyboard access, visible focus, dialog dismissal and terminal focus return.
- Task-centric sidebar, grouped by project; convenient project addition/selection.
- Coherent settings/configuration surface, not scattered controls.
- Use T3 Code and Orca as references, selectively rather than copying their entire interaction model.

Current stack is Tailwind + a strict Base UI/cmdk kit. Shadcn is a reference/candidate, not an adopted stack migration.
Assess reuse and licenses before copying reference code from `../playtest/.refs/`.

## Candidate slices and acceptance

### Task history and session labels

- Search current and settled tasks; open a result in its existing workspace/session context.
- Continue a settled task using the existing lifecycle rather than creating a duplicate.
- Rename the user-facing terminal/session label; preserve identity and agent kind.
- Establish what survives reload/server restart and verify it through the UI.

### GitHub / GitLab and titles

- Research issue import, source links, PR/MR visibility and self-hosted GitLab support.
- Propose the smallest useful integration; bidirectional synchronization is not assumed.
- Existing title-to-branch behavior is not a new title-generation feature.
- Clarify whether generation means a title from the initial prompt, a title from an issue, or another flow.
- A missing CLI, authentication, network or generator must leave manual task creation usable.
- Publish no issues, comments, commits or PRs/MRs as part of research or verification.

### Profiles, providers and chat

- Separate launching/configuring an agent CLI from using a model provider directly.
- Research named profiles, model discovery/selection, environment inheritance/overrides and secret redaction/storage.
- A provider feature must not silently require another paid API account.
- Chat and terminal should refer to the same agent conversation where supported; document agent-specific limits.
- Establish one-writer ownership, approval routing and what a view switch loses before implementing switching.

## Decision boundaries

- Titles: support issue titles directly and research prompt-derived titles; do not invent an extra provider dependency.
- Integration: start with issue import and source links; derive GitLab host from explicit input/remotes where supported. Remote writes and bidirectional sync are not authorized by this backlog.
- Chat: implement a thin supported slice only when history, writer ownership and approvals have an evidence-backed design. Otherwise record findings and continue elsewhere.
- Stack: improve the current strict UI kit first; framework/kit replacement needs a separate decision.
- Sidebar: task-first stays the baseline; an alternative branch/worktree view is exploratory, not a second data model yet.

## Research handoffs

- `backlog-inventory` (explorer): existing behavior and reusable local UX references, with file/line references.
- `chat-provider-research` (researcher): current supported agent/provider interfaces and a minimal staged design.
- `git-title-research` (researcher): integration/authentication options and title-generation flows.
- `web5-verify` (e2e-verifier): finish the current MVP5 feature independently of the new backlog.

Replace pending questions with linked decisions and implementation-sized tasks after the reports arrive.
