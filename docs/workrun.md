# Workrun

Kind: **engineering rules**. A general-purpose launcher for developer commands and background
services. Linux only: Node from this repository's toolchain, systemd **254+** with a reachable user
manager, cgroup v2's memory controller, and util-linux `flock`. No sudo, Docker or additional daemon.

## Setup

Configure one shared budget explicitly, once per user machine:

```sh
pnpm workrun setup --memory-high 10G --memory-max 12G --cpu-quota 600%
```

`setup` writes a managed `workrun.slice` under `$XDG_CONFIG_HOME/systemd/user` (default
`~/.config/systemd/user`), reloads the user manager and applies the budget immediately. It refuses to
replace an unmanaged file. These settings survive reboot; the jobs do not auto-start after reboot.
Only workrun units are configured, not the desktop or the whole user session. Updating a budget can
throttle or kill existing workrun jobs, so inspect running jobs before lowering it.

All checkouts and projects for the same user share this slice and heavy slot. Commands fail closed
if setup, the user manager or the kernel memory limit is unavailable or does not match the config.
The thin CLI itself and the coding-agent session run outside the slice; their workload children
are launched inside it.

## Scopes and budgets

Every launch requires `--scope`: a project or an assignment's namespace. Names are 1–48 lowercase
letters, digits, underscores or hyphens, starting with a letter or digit. Job names are local to the
scope. The scope is a resource/lifecycle group, not a container or a separate filesystem/network.

By default scopes share the global budget with no additional ceiling. To add or remove a scope's
own ceilings:

```sh
pnpm workrun scope set corral --memory-high 6G --memory-max 8G --cpu-quota 400%
pnpm workrun scope set corral --memory-high inherit --memory-max inherit --cpu-quota inherit
```

Omitted fields keep their current values. `inherit` removes the local constraint; the parent still
applies. The limits are ceilings, **not reservations**: scopes capped at 8G and 6G together cannot
exceed a 12G parent. `memory-high` starts reclaim/throttling; `memory-max` is the hard boundary that
can trigger OOM within the constrained group. A root-budget OOM can kill any workrun job, not
necessarily the newest. Services use `OOMPolicy=kill` so an OOM does not leave half a job running.
These RAM limits do not configure or cap swap.

`--cpu-quota` accepts positive integer percentages: **600% means up to six logical CPUs' worth of
CPU time for all jobs combined**, not 600% of the whole machine. The scheduler enforces this per
quota period, so short bursts are possible; it does not pin processes to particular cores. Scope
quotas further restrict that scope; they neither reserve CPU nor override the shared ceiling.
Omitting CPU quota preserves the existing setting (initially uncapped); `inherit` removes the local
quota, including the root quota when passed to `setup`. Memory still requires a finite root budget.
Quotas are verified against the kernel's `cpu.max`, and `status --json` includes job CPU usage.

Sizes are positive integers in bytes or with K/M/G/T suffixes (base 1024). The shared budget must
have finite high and max values. Scope settings use managed slice files beside the root file;
live updates also use systemd's runtime property drop-ins. This is host configuration, not checked
into a project. To inspect aggregate usage or pressure:

```sh
systemctl --user show workrun.slice -p MemoryCurrent -p MemoryPeak -p MemoryHigh -p MemoryMax -p CPUQuotaPerSecUSec -p CPUUsageNSec
```

## Run or start

```sh
# Foreground: inherit cwd and environment, stream output, return the command's exit code.
pnpm workrun --scope corral run -- pnpm seed

# Background: return after exec succeeds, keep running independently of the launching terminal.
pnpm workrun --scope corral start web -- pnpm dev --fake-agents

# One cross-project heavy slot, nonblocking. Optional for both run and start.
pnpm workrun --scope corral run --heavy -- pnpm check
pnpm workrun --scope corral start browser-tests --heavy -- pnpm test:browser
```

`--` is required before the executable; arguments after it remain literal (no implicit shell or
systemd variable expansion). Executables resolve using the caller's PATH. Environment values are
passed to systemd without embedding secret values in the launcher's argv; systemd-specific parent
identity/socket variables are not forwarded. The user manager supplies the new service's identity.
Like any user service, its environment is accessible to the same user: this is not a secret store.

`run` generates a job name, prints it on stderr and waits until **all processes** in the service's
cgroup exit, including detached children. Use `--name NAME` before `--` for a predictable name.
SIGINT, SIGTERM and SIGHUP request whole-job cleanup; interruption returns 128 + signal number.
A terminal uses a PTY; redirected output uses a pipe. It is not an interactive login session.

`start NAME` requires a unique name within the scope. It does not replace an existing job and does
not restart failed commands. Success means the executable started, **not** that an HTTP endpoint is
ready; wait for an application-level readiness signal. Logs go to the user journal. A daemon that
forks stays tracked even after its original parent exits (`ExitType=cgroup`).

`--heavy` serializes admission through `$XDG_RUNTIME_DIR/workrun-heavy.lock`; active/deactivating
heavy jobs then retain the slot in systemd until their entire group exits. This works for background
jobs too, without a custom supervisor. Busy returns **75**, not an unbounded wait. A payload can also
return 75, so inspect the diagnostic before treating it as contention. After a busy result the
orchestrator schedules a later attempt rather than polling. Do not nest heavy launches inside a
heavy command: the inner invocation will find the slot occupied.

One heavy job can itself spawn many workers. Bound its internal parallelism separately, for
example `CORRAL_BROWSER_SHARDS=2 pnpm workrun --scope corral run --heavy -- pnpm test:browser`.
Only cooperating launcher invocations serialize; directly executed commands bypass both controls.

## Inspect and stop

```sh
pnpm workrun list                              # all managed jobs across scopes
pnpm workrun --scope corral list
pnpm workrun --scope corral status web         # state, PID, memory, cgroup and result
pnpm workrun --scope corral logs web
pnpm workrun --scope corral logs web --follow
pnpm workrun --scope corral stop web
pnpm workrun --scope corral stop --all
```

`list` and `status` accept `--json`. Live and failed background units are visible; successful jobs
may be unloaded by systemd. Their output remains in the journal according to its retention policy.
Repeated use of the same scope/name shares that journal history. Foreground output is streamed to
the terminal, not duplicated into the journal; capture it explicitly if evidence must survive.

Stop sends SIGTERM to the whole service cgroup, waits up to five seconds, then uses SIGKILL for
remaining processes. `stop --all` requires an explicit scope and selects only that scope's managed
jobs, including failed ones. It resets their failed state so names can be reused. It never deletes
worktrees, application state, logs or scope budgets. Completion means systemd completed the stop.

SIGKILL or a host crash cannot run foreground cleanup handlers. Background jobs deliberately
survive their launcher. After an interrupted agent, inspect `list` and stop that assignment's scope.
A process routed through an **already-running external daemon** (tmux server, browser daemon,
Docker, another systemd service) may run outside this cgroup. Launch a fresh task-owned daemon
inside the unit and verify its cgroup; wrapping a client command does not move an existing daemon.

## Agent workflow in this repository

1. Read `pnpm workrun --help`; check `pnpm workrun list`. Setup is a deliberate host change, not an
   automatic response to a failing command. Reuse the configured budget unless the user approves a change.
2. Assign a scope to the task, e.g. `corral-picker-audit`. Use a separate scope for a shared stack;
   an audit must not stop it. At most **two live development stacks total**, and **one implementation
   worker**, until this resource policy is explicitly revised.
3. Run development stacks with `start`; run checks, browser/e2e suites and dependency installation
   with `run --heavy`. On a fresh checkout without dependencies, the bootstrap form is
   `node scripts/workrun/cli.mjs --scope corral-install run --heavy -- pnpm install --frozen-lockfile`.
   On hosts without this Linux infrastructure, report the missing protection; this launcher has no
   unbounded fallback. Existing non-Linux CI commands remain unchanged.
4. Run browser automation with a task-owned named session, keep its daemon inside the assignment's
   managed job and verify the actual browser's `/proc/<pid>/cgroup`. Save evidence outside `/tmp`
   before teardown. Close **that session**, then stop its managed job/scope; avoid global browser kills.
5. Before handoff, stop the assignment's jobs and require its `list --json` to be `[]`. For an
   intentionally shared service, report its owner and name instead. Save code/checkpoints and
   findings in the repository or GitHub before deleting temporary worktrees. Stopping an agent alone
   is not proof that its servers and browsers stopped.

## Verification

The regular Node suite covers parsing and namespace/budget rules without changing host settings.
After explicit setup, `pnpm test:workrun` opts into real user-systemd tests: cross-scope admission,
argv/cwd/environment, background ownership, descendant cleanup, journal output, aggregate memory
CPU quota readback and actual kernel throttling, and a deliberate small **64 MiB** scope OOM. Test scopes and their configuration are removed on
completion. Do not run this suite under `--heavy`: it tests acquisition of that same slot. Run it in
a plain managed `run` while no unrelated heavy job is active. It never changes the shared budget.

systemd owns process lifecycle and journal retention; flock owns admission locking. The CLI keeps
no second PID registry, restart scheduler or supervisor state. This is tooling, not Corral's
production server manager.
