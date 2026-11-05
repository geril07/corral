# Workrun — setup and budgets

Kind: **engineering rules**. For the host owner provisioning or deliberately changing resources.
Ordinary callers read [Usage](usage.md); orchestrators read [Orchestration](orchestration.md).

## Provision a host

Requires Linux, Node from this repository's toolchain, systemd **254+** with a reachable user
manager, cgroup v2's memory controller, and util-linux `flock`. No sudo, Docker or extra daemon.

Inspect existing jobs before configuring or lowering a budget:

```sh
pnpm workrun list
# Example host-owner-selected budget:
pnpm workrun setup --memory-high 6G --memory-max 8G --cpu-quota 400%
```

`setup` writes managed `workrun.slice` under `$XDG_CONFIG_HOME/systemd/user` (default
`~/.config/systemd/user`), reloads the manager and applies limits immediately. It refuses to
replace an unmanaged file. Configuration survives reboot; jobs do not auto-start.
Only workrun units are configured, not the desktop or whole user session. Lowering budgets can
throttle or kill existing jobs. The CLI and coding-agent session are outside the slice.

All groups, projects and checkouts for the same user share this CPU/RAM budget. Launches fail
closed if setup, the user manager or kernel memory limits are missing/stale.

## Group settings

A group starts with one heavy slot and inherited resource ceilings:

```sh
pnpm workrun group set corral --heavy-slots 2
pnpm workrun group set corral --memory-high 4G --memory-max 6G --cpu-quota 200%
pnpm workrun group set corral --memory-high inherit --memory-max inherit --cpu-quota inherit
```

Omitted fields retain their values. `inherit` removes a local resource ceiling; the parent still
applies. Ceilings are **not reservations**: two groups capped at 6G together cannot exceed an 8G
parent. Group names are flat; `corral-135` is not a child of `corral`.

`--heavy-slots` is a positive integer. Different groups have independent admission; the shared
resource budget is not multiplied. Reducing the count does not pre-empt existing heavy jobs:
new ones wait until occupancy is below the new limit. Full suites can still spawn many internal
workers, whose count must be bounded separately.

- **RAM:** positive integer bytes or K/M/G/T suffixes (base 1024). Root high/max must be finite.
  High starts reclaim/throttling; max can cause OOM inside the group. A root-budget OOM may kill
  any managed job, not necessarily the newest. Jobs use `OOMPolicy=kill` to avoid a half-dead
  process tree. These limits do not cap swap.
- **CPU:** positive integer percentages. **400% means four logical CPUs' worth of time for all
  root-budget jobs together**, not 400% of the machine. Short bursts within quota periods are
  possible; this is not core affinity. Group quotas only narrow the root allowance. CPU is
  uncapped until configured; `inherit` also removes the root quota when given to `setup`.

Group configuration lives beside the root slice. Admission count is a workrun-owned
`# HeavySlots=` comment in the group's managed slice file, not a systemd resource property.
Writes and admission use the same short group lock. The launcher verifies resource ceilings
against kernel cgroup files before executing a payload.

## Upgrade from the scope API

Use `--group` / `group set`; the old CLI names are not aliases. Existing managed slice filenames,
resource settings and job unit names are preserved. Existing group files without a slot setting
default to one. No setup or budget reset is needed.

Admission uses per-group lock files in `$XDG_RUNTIME_DIR`; it no longer uses the old global
heavy lock. Do not mix old/new launchers for heavy jobs in the **same project** during rollout:
they do not share admission. Finish the old jobs and update all of that project's callers first.
Different projects still share the root resource budget. Lock files are not unlinked, because
replacing an inode could let two launchers believe they hold the same lock.

## Inspect the shared budget

```sh
systemctl --user show workrun.slice \
  -p MemoryCurrent -p MemoryPeak -p MemoryHigh -p MemoryMax \
  -p CPUQuotaPerSecUSec -p CPUUsageNSec
```
