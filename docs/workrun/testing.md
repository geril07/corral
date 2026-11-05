# Workrun — launcher verification

Kind: **engineering rules**. For launcher maintainers. Regular Node tests cover parsing, names,
budget/configuration rules without changing host settings. The opt-in suite exercises the real
CLI, user systemd, cgroups and flock; it never replaces the user's root budget.

After the host owner has completed [Setup](setup.md):

```sh
pnpm workrun --group corral run --name workrun-tests --heavy -- pnpm test:workrun
```

This is a full suite, so the outer invocation is heavy. The suite creates its own unique groups
for admission probes: those do not share the outer project's slots. It cleans up its jobs,
group configuration and temporary files even on failure. Run it when shared CPU/RAM has
headroom; group isolation does not create a separate resource budget.

Coverage must include:

- literal argv/cwd/environment and payload exit status, including exit 75;
- background lifetime, duplicate names, owned cancellation and detached-descendant cleanup;
- project-independent admission and same-group cross-directory exclusion;
- concurrent admission at N > 1 for foreground/background jobs, retaining capacity through
  orphan descendants and deactivation;
- default waiting, explicit no-wait, cancelled waiters (including an incumbent's same name),
  and live slot-count changes;
- persisted/default slot counts and preservation of omitted budgets and older managed files;
- journal output, summed memory, missing/stale kernel-budget refusal;
- CPU quota readback/throttling and a deliberate bounded **64 MiB** group OOM.

Use observable readiness/exit/state signals with deadlines, not bare sleeps. Verify that only
test-owned jobs/configuration are removed. The full `pnpm check` gate is also required for
launcher/config changes. Browser/Electron suites are needed only when their app surfaces change.
