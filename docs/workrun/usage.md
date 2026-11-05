# Workrun — use a job

Kind: **engineering rules**. For callers on an already configured host. [Setup](setup.md) is for
provisioning and resource changes; [orchestration](orchestration.md) is for assigning agent work.

## Group and job

Every launch requires `--group`. Use the project's group in every worktree; use distinct job
names for concurrent assignments. Groups are flat names, not directories or nested namespaces.
Names are 1–48 lowercase letters, digits, underscores or hyphens, starting with a letter or digit.

A group shares CPU/RAM and heavy capacity; it does not isolate source files, ports or databases.
The current directory is the command's working directory.

```sh
pnpm workrun --group corral run -- pnpm install --frozen-lockfile
pnpm workrun --group corral run -- pnpm typecheck
pnpm workrun --group corral start issue135-dev -- pnpm dev --fake-agents
pnpm workrun --group corral run --name issue135-check --heavy -- pnpm check
```

On a checkout without dependencies, use `node scripts/workrun/cli.mjs` instead of `pnpm workrun`.
No launch changes the configured budget.

## Which commands are heavy?

**Only a full test suite takes `--heavy`.** All other workloads still use workrun's CPU/RAM budget.

| Workload                                                        | Heavy |
| --------------------------------------------------------------- | ----- |
| Full Node, browser, Electron/e2e or launcher test suite         | Yes   |
| Aggregate gate that includes a full suite, such as `pnpm check` | Yes   |
| Selected test files or a filtered test case                     | No    |
| Install dependencies, typecheck, lint, format, build            | No    |
| Development stack or seed command                               | No    |

Heavy is caller-declared, not inferred from executable names. Internal suite workers/shards still
need their own bound; for example use `CORRAL_BROWSER_SHARDS=2` for a full browser run on a modest
shared budget. CPU/RAM ceilings protect the host, but competing workloads can slow down or exhaust
the jobs' own shared memory budget.

## Run or start

`run` streams the command's output, waits for every process in its job, and returns the command's
exit status. Its generated name is printed to stderr; `--name JOB` makes it predictable.
SIGINT, SIGTERM and SIGHUP cancel admission or stop the running job; interruption returns
128 + signal number. A terminal uses a PTY; redirected output uses a pipe.

`start JOB` returns after successful exec, **not application readiness**. Observe the application's
readiness separately. Output goes to the user journal. The job outlives the CLI, including detached
descendants after the original process exits. It has no automatic restart or reboot start.
An existing job name in the same group is refused, not replaced; other groups may reuse the name.

`--` is required before the executable. Arguments stay literal; there is no implicit shell or
systemd variable expansion. Executables resolve through the caller's PATH. Environment variables
are forwarded without embedding secret values in launcher argv; systemd identity/socket variables
are replaced by the new service's context. The environment is accessible to the same user:
workrun is not a secret store.

## Heavy admission

Each group has one heavy slot by default; the host owner can set another positive
`--heavy-slots` count with `group set`. Different groups admit independently, while all jobs
still share the root resource budget. Active, activating and deactivating heavy jobs retain
capacity until their entire cgroup exits.

```sh
# Wait for this project's capacity, then execute exactly once.
pnpm workrun --group corral run --name issue135-check --heavy -- pnpm check

# Opt out of waiting: busy admission returns 75 without launching the command.
pnpm workrun --group corral run --heavy --no-wait -- pnpm test:browser
```

Waiting prints a message and stays in the invoking CLI; it is not completion, a durable queue or
a FIFO promise. The launcher rechecks systemd capacity with an idle timer, not a busy loop.
Do not add agent sleep/retry loops. Set the caller's timeout to cover both waiting and execution.
Cancel the waiting CLI to withdraw it: no payload has started, and no existing job is stopped.
Waiters are not yet systemd jobs, so they do not appear in `list` and `stop` does not cancel them.

`start JOB --heavy` also waits for admission before returning after exec. Its background job keeps
the slot afterwards. A nested heavy invocation in a full group waits for its own parent;
run the whole suite under one admission and leave its child commands unmarked.
A payload can itself exit 75; only the explicit admission diagnostic means capacity was busy.

## Inspect and stop

```sh
pnpm workrun list
pnpm workrun --group corral list --json
pnpm workrun --group corral status issue135-dev --json
pnpm workrun --group corral logs issue135-dev --follow
pnpm workrun --group corral stop issue135-dev
pnpm workrun --group corral stop --all
```

`list` and `status` accept `--json`; job records identify `group` and `name`.
Status includes PID, memory, CPU usage and cgroup. Live and failed background jobs remain visible;
successful jobs may be unloaded. Journal retention is system-managed; reusing a group/name shares
its journal history. Foreground output is not journal-copied: save it when it must survive.

Stop targets the whole cgroup: SIGTERM, up to five seconds, then SIGKILL for remaining processes.
It also resets failed state so names can be reused. `stop --all` requires a group and affects every
managed job in that group, including other worktrees. Stop completes only after systemd's stop
finishes. It deletes no worktrees, application data, budgets or logs.

## Ownership boundary

A background job is not cleaned up merely because its agent exited. The caller or orchestrator
must stop it. Direct launches bypass workrun. An existing external daemon (browser, tmux, Docker,
another service) may spawn work outside the invoking job; wrapping its client does not relocate
it. External shared browser daemons are not promised containment by this workflow.
