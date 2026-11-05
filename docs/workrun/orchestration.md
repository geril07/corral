# Workrun — orchestrate agent workloads

Kind: **engineering rules**. For the orchestrator assigning concurrent work and owning cleanup.
Callers use [Usage](usage.md), including its authoritative heavy classification.
Host provisioning and budget changes belong to [Setup](setup.md).

1. Inspect `pnpm workrun list --json`. Assign the project's **same group across worktrees** and
   unique job names to the brief, e.g. group `corral`, jobs `issue135-dev`, `issue135-check`.
   Record each owner, checkout and intended lifetime. Completion: every launch has a named owner;
   existing shared jobs are explicitly borrowed, not assumed abandoned.
2. Give independent stacks separate persistent worktrees, each with its own `.dev/`, and
   explicit web ports. `pnpm dev` derives state/data/config from its checkout; another group or
   job name does not give two launches in one checkout separate databases. Shared stacks have
   one owner coordinating source updates and fixture mutations. Completion: neither checkout,
   application state nor network address conflicts with another live assignment.
3. Delegate CLI calls using [Usage](usage.md) and its heavy classification. Let workrun wait for
   heavy capacity and give the invoking tool enough time for admission plus execution.
   Track the waiting invocation so it
   can be cancelled; it is not in the systemd job list. Completion: the agent has one launch
   path, not a sleep/retry loop, and knows which result proves readiness or check completion.
4. After `start`, observe application readiness. Keep each live stack attached to current work;
   stop it when that work ends. There is no launcher-enforced stack/worker count: choose
   concurrency against the shared budget and disjoint file ownership. Completion: every live
   stack is ready and has an active owner; no idle stack is retained without an explicit reason.
5. Before handoff, save code/checkpoints and evidence outside `/tmp`, cancel the assignment's
   waiting CLIs and stop **its named jobs**. Inspect the group's JSON list and require those
   names to be absent. Other assignments may remain in the project group; report shared jobs
   by owner/name. Use `stop --all` only when the whole group belongs to the cleanup.
   Completion: durable results exist and no owned invocation or job is left running.

On failure or interruption, the orchestrator performs the same assignment-specific cleanup.
An agent's exit is not proof that servers or detached processes stopped. Browser-session
ownership remains with its caller; use named sessions and close only the owned session.
Do not claim an external shared browser daemon is inside a job's CPU/RAM boundary.
