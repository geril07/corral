# Corral — orchestrate local workloads

Kind: **engineering rules**. For the orchestrator assigning concurrent work and owning cleanup.
[Project policy](../workrun.md) owns the group, entrypoints and heavy classification;
[tool usage](../../scripts/workrun/docs/usage.md) owns lifecycle and cancellation semantics.

1. Inspect `pnpm workrun list --json`. Give the brief its project group, unique job names, owner,
   checkout and intended lifetime. Completion: every launch has a named owner; shared jobs are
   explicitly borrowed rather than assumed abandoned.
2. Give independent Corral stacks separate persistent worktrees and distinct web ports.
   `pnpm dev` uses its checkout's `.dev/`; group/job names do not create separate databases.
   The dev layout and fake-agent setup are defined in [Engineering](../engineering.md#toolchain).
   Shared stacks have one owner coordinating source updates and fixture mutations.
   Completion: source, app state and network addresses do not conflict with another assignment.
3. Delegate commands using the project's heavy classification. Let workrun handle admission;
   track waiting invocations so they can be cancelled. Completion: the agent knows which
   command/result proves readiness or check completion and has no sleep/retry loop.
4. Observe readiness after `start`. Keep each stack attached to current work and stop it when
   that work ends. Choose concurrency against the shared budget and disjoint file ownership;
   workrun has no automatic dev-stack or implementation-worker count limiter.
   Completion: every live stack is ready and has an active owner or an explicit retention reason.
5. Before handoff, save code/checkpoints and evidence outside `/tmp`, cancel owned waiting CLIs
   and stop **the assignment's named jobs**. Require those names to be absent from the project's
   JSON job list; report shared jobs left running by owner/name. Use `stop --all` only for cleanup
   of the whole project group. Completion: results are durable and no owned invocation/job remains.

After an agent failure or interruption, the orchestrator performs the same assignment-specific
cleanup. Browser-session ownership stays with its caller: close only the owned named session.
An external shared browser daemon is not assumed inside workrun's resource boundary.
