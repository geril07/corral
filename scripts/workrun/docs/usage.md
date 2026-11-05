# Workrun — CLI and lifecycle

Kind: **tool documentation**. For callers on a configured host. Provisioning belongs to
[Setup](setup.md); launcher verification belongs to [Verification](testing.md).

Examples use `workrun` as shorthand for `node /absolute/path/to/cli.mjs` or the integrating
environment's wrapper. The launcher does not install a global executable.

## Group and job

Every launch requires `--group`. Groups are flat namespaces with independent admission and optional
resource ceilings under one shared budget. Job names are unique within a group. Names are 1–48
lowercase letters, digits, underscores or hyphens, starting with a letter or digit.

```sh
workrun --group example run -- node --version
workrun --group example start worker -- node -e 'setInterval(() => {}, 1000)'
workrun --group example run --name batch --heavy -- ./batch-job
```

The current directory is the command's working directory. A group does not isolate files,
network ports or application state. Group/job naming and the choice of heavy commands belong
to the integrating project. No launch changes the configured budget.

## Run or start

`run` streams output, waits for every process in the job and returns the command's exit status.
Its generated name is printed to stderr; `--name JOB` makes it predictable. SIGINT, SIGTERM and
SIGHUP cancel admission or stop the running job; interruption returns 128 + signal number.
A terminal uses a PTY; redirected output uses a pipe.

`start JOB` returns after successful exec, **not application readiness**. Observe readiness
separately. Output goes to the user journal. The job outlives the CLI, including detached
descendants after the original process exits. It has no automatic restart or reboot start.
An existing job name in the same group is refused, not replaced; other groups may reuse the name.

`--` is required before the executable. Arguments stay literal; there is no implicit shell or
systemd variable expansion. Executables resolve through the caller's PATH. Environment variables
are forwarded without embedding secret values in launcher argv; systemd identity/socket variables
are replaced by the new service's context. The environment is accessible to the same user:
workrun is not a secret store.

## Heavy admission

`--heavy` opts into the group's bounded admission. Workrun does not infer heaviness from a command,
and does not prescribe which workloads use it. Without the flag a job still gets CPU/RAM limits.

Each group has one heavy slot by default; `group set --heavy-slots N` configures another positive
count. Different groups admit independently, while all jobs share the root resource budget.
Active, activating and deactivating heavy jobs retain capacity until their entire cgroup exits.

```sh
# Wait for this group's capacity, then execute once.
workrun --group example run --name batch --heavy -- ./batch-job

# Opt out of waiting: busy admission returns 75 without launching the command.
workrun --group example run --heavy --no-wait -- ./batch-job
```

Waiting prints a message and stays in the invoking CLI; it is not completion, a durable queue or
a FIFO promise. The launcher rechecks systemd capacity with an idle timer, not a busy loop.
The caller's timeout must cover waiting plus execution. Cancel the waiting CLI to withdraw it:
no payload has started and no existing job is stopped. Waiters are not yet systemd jobs,
so they do not appear in `list` and `stop` does not cancel them.

`start JOB --heavy` also waits for admission before returning after exec. Its background job keeps
the slot afterwards. A nested heavy invocation in a full group waits for its own parent; admit
the workload once rather than nesting admission in the same saturated group.
A payload can itself exit 75; only the explicit admission diagnostic means capacity was busy.
The number of processes/workers inside one admitted job is not bounded by the slot count.

## Inspect and stop

```sh
workrun list
workrun --group example list --json
workrun --group example status worker --json
workrun --group example logs worker --follow
workrun --group example stop worker
workrun --group example stop --all
```

`list` and `status` accept `--json`; job records identify `group` and `name`.
Status includes PID, memory, CPU usage and cgroup. Live and failed background jobs remain visible;
successful jobs may be unloaded. Journal retention is system-managed; reusing a group/name shares
its journal history. Foreground output is not journal-copied: save it when it must survive.

Stop targets the whole cgroup: SIGTERM, up to five seconds, then SIGKILL for remaining processes.
It resets failed state so names can be reused. `stop --all` requires a group and affects every
managed job in it. Stop completes only after systemd's stop finishes. It deletes no application
data, budgets or logs.

## Ownership boundary

Background jobs require explicit cleanup by their owner, including after an interrupted caller.
Direct launches bypass workrun. An existing external daemon (browser, tmux, Docker, another
service) may spawn work outside the invoking job; wrapping its client does not relocate it.
The tool does not promise containment of such an external daemon.
