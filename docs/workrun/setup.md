# Workrun — setup and budgets

Kind: **engineering rules**. For the person provisioning the host or changing its resource budget.
For ordinary command/service use, read [Usage](usage.md) instead.

## Provision a host

Requires Linux, Node from this repository's toolchain, systemd **254+** with a reachable user
manager, cgroup v2's memory controller, and util-linux `flock`. No sudo, Docker or additional daemon.

Inspect existing jobs before configuring or lowering a budget:

```sh
pnpm workrun list
# Example budget, chosen explicitly for the host:
pnpm workrun setup --memory-high 6G --memory-max 8G --cpu-quota 400%
```

`setup` writes a managed `workrun.slice` under `$XDG_CONFIG_HOME/systemd/user` (default
`~/.config/systemd/user`), reloads the user manager and applies the budget immediately. It refuses
to replace an unmanaged file. Settings survive reboot; jobs do not auto-start after reboot.
Only workrun units are configured, not the desktop or whole user session. Lowering limits can
throttle or kill existing workrun jobs.

All checkouts and projects for the same user share this slice and heavy slot. Launches fail closed
if setup, the user manager or the kernel memory limit is unavailable or does not match the config.
The thin CLI and coding-agent session are outside the slice; their workload children run inside it.

## Shared and per-scope limits

Scopes initially share the parent budget with no extra ceiling. Add or remove local ceilings:

```sh
pnpm workrun scope set corral --memory-high 4G --memory-max 6G --cpu-quota 200%
pnpm workrun scope set corral --memory-high inherit --memory-max inherit --cpu-quota inherit
```

Omitted fields retain their current values. `inherit` removes the local constraint; the parent
still applies. Ceilings are **not reservations**: two scopes capped at 6G each together cannot
exceed an 8G parent.

- **RAM:** positive integers in bytes or K/M/G/T suffixes (base 1024). The shared budget requires
  finite high and max values. High starts reclaim/throttling; max can trigger OOM within the
  constrained group. A parent-budget OOM can kill any workrun job, not necessarily the newest.
  Services use `OOMPolicy=kill` to avoid leaving half a job running. These limits do not cap swap.
- **CPU:** positive integer percentages; **400% means four logical CPUs' worth of CPU time for all
  jobs combined**, not 400% of the machine. Enforcement is per quota period, so short bursts are
  possible; this is not core affinity. Scope quotas narrow the parent's allowance, never reserve
  CPU or override the parent. CPU starts uncapped if not configured. `inherit` removes the local
  quota, including the root quota when passed to `setup`.

Scope files live beside the root file; immediate changes also use systemd runtime property
drop-ins. Host budgets are not checked into the repository. The launcher verifies configured limits
against kernel cgroup files before launching payloads.

## Inspect the shared budget

```sh
systemctl --user show workrun.slice \
  -p MemoryCurrent -p MemoryPeak -p MemoryHigh -p MemoryMax \
  -p CPUQuotaPerSecUSec -p CPUUsageNSec
```

After configuration succeeds, use [Usage](usage.md) or the [agent workflow](agents.md).
