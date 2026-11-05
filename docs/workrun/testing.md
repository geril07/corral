# Workrun — launcher verification

Kind: **engineering rules**. For maintainers changing or verifying workrun, not ordinary workloads.
Systemd owns lifecycle and journal retention; flock owns admission. The CLI has no second PID
registry, restart scheduler or supervisor. It is not Corral's production server manager.

The regular Node suite covers parsing, names and budget rules without changing host settings.
After a host owner has completed [explicit setup](setup.md), opt into the real user-systemd suite:

```sh
pnpm workrun --scope workrun-verify run -- pnpm test:workrun
```

Run this while no unrelated heavy job is active, **without `--heavy`**: the suite tests acquisition
of that very slot. It never changes the shared budget. It creates unique test scopes, then removes
their jobs and configuration.

Coverage includes cross-scope admission and races, literal argv/cwd/environment, background
ownership, detached-descendant cleanup, journal output, aggregate memory, missing/stale kernel
budget refusal, CPU quota readback and actual throttling, and a deliberate bounded **64 MiB** scope
OOM. This is the real-interface verification for launcher changes; app browser/Electron suites
are required only if their own surfaces change.
