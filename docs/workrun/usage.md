# Workrun — commands and services

Kind: **engineering rules**. For consumers on an already configured host. Read
[Setup](setup.md) only when provisioning or deliberately changing a budget; report missing
protection instead of bypassing it. Coding agents also follow [their ownership workflow](agents.md).

## Choose a scope and launch

Every launch requires `--scope`: a project or assignment namespace. Names are 1–48 lowercase
letters, digits, underscores or hyphens, starting with a letter or digit. Job names are local to a
scope. A scope groups resources/processes; it is not a separate filesystem or network.

```sh
# Foreground: inherit cwd/environment, stream output, return the command's exit code.
pnpm workrun --scope corral run -- pnpm seed

# Background: keep running independently of the launching terminal.
pnpm workrun --scope corral start web -- pnpm dev --fake-agents

# One cross-project heavy slot, available for either lifetime.
pnpm workrun --scope corral run --heavy -- pnpm check
pnpm workrun --scope corral start browser-tests --heavy -- pnpm test:browser
```

`--` is required before the executable. Arguments stay literal: no implicit shell or systemd
variable expansion. Executables resolve through the caller's PATH. Normal environment variables
are forwarded without embedding secret values in the launcher's argv; systemd parent
identity/socket variables are replaced by the new service's context. The environment remains
accessible to the same user: this is not a secret store.

`run` prints its generated job name on stderr and waits for **all processes** in its cgroup,
including detached children. Use `--name NAME` before `--` for a predictable name. SIGINT, SIGTERM
and SIGHUP request whole-job cleanup; interruption returns 128 + signal number. A terminal uses a
PTY; redirected output uses a pipe. It is not an interactive login session.

`start NAME` refuses an existing name; it neither replaces jobs nor restarts failed commands.
Success means exec succeeded, **not** application readiness: wait for the service's own readiness
signal. Output goes to the user journal. Forked daemons remain tracked after their original
parent exits.

## Heavy admission

`--heavy` uses one shared admission lock in `$XDG_RUNTIME_DIR/workrun-heavy.lock`. An active or
deactivating heavy job keeps the slot until its entire cgroup exits, even after a background
launcher returns. Busy exits **75** without waiting; a payload can also return 75, so inspect the
diagnostic. Schedule a later attempt rather than polling. A nested heavy invocation finds its
parent's slot occupied.

One job can itself spawn many workers. Bound that parallelism separately, for example:

```sh
CORRAL_BROWSER_SHARDS=2 pnpm workrun --scope corral run --heavy -- pnpm test:browser
```

Only cooperating launcher calls serialize. Direct commands bypass both admission and the budget.

## Inspect and stop

```sh
pnpm workrun list
pnpm workrun --scope corral list
pnpm workrun --scope corral status web
pnpm workrun --scope corral logs web
pnpm workrun --scope corral logs web --follow
pnpm workrun --scope corral stop web
pnpm workrun --scope corral stop --all
```

`list` and `status` accept `--json`. Status includes PID, memory, CPU usage and cgroup. Live and
failed background units remain visible; successful units may be unloaded. Journal output follows
system retention; repeated use of one scope/name shares its history. Foreground output is streamed,
not automatically journal-copied: capture it explicitly when it must survive.

Stop sends SIGTERM to the whole cgroup, waits up to five seconds, then uses SIGKILL for remaining
processes. `stop --all` requires an explicit scope and stops only its managed jobs, including
failed ones; it resets failed state so names can be reused. It deletes no application data,
worktrees, logs or budgets. Completion means systemd completed the stop.

## Ownership limits

Background jobs deliberately outlive their launcher. SIGKILL or a host crash cannot execute
foreground cleanup handlers. After an interrupted owner, inspect `list` and stop its jobs.

Calling an **existing external daemon** (tmux, a browser daemon, Docker or another systemd service)
can route work outside this cgroup. Launch a fresh owned daemon inside the unit and verify the
actual process's `/proc/<pid>/cgroup`; wrapping a client does not relocate an existing daemon.
