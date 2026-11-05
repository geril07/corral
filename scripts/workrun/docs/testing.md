# Workrun — verification contract

Kind: **tool documentation**. For launcher maintainers. The test-runner commands and gate policy
belong to the integrating repository; the invariants below belong to workrun.

Pure tests cover parsing, names and persisted budget/admission rules. Real-interface tests must
exercise the CLI against user systemd, cgroups and flock after explicit host [setup](setup.md).
Tests use unique groups, preserve the shared host budget and remove only their own jobs,
configuration and temporary data. All groups still share resources: use host headroom, not
group names, as evidence that a resource probe is safe.

Required behavior:

- literal argv/cwd/environment and payload exit status, including exit 75;
- background lifetime, duplicate names, invocation-owned cancellation and descendant cleanup;
- independent admission between groups and shared capacity across directories in one group;
- concurrent admission at N > 1 for foreground/background jobs, retaining capacity through
  orphan descendants and deactivation;
- default waiting, explicit no-wait, cancelled waiters (including an incumbent's same name),
  and live slot-count changes;
- persisted/default slot counts and preservation of omitted budgets and older managed files;
- journal output, summed memory and missing/stale kernel-budget refusal;
- CPU quota readback/throttling and a deliberate bounded **64 MiB** group OOM.

Use observable readiness/exit/state signals with deadlines, not bare sleeps. Admission probes
must use groups separate from the test runner's own group when the runner occupies heavy capacity.
Assert cleanup on failure as well as success; ending the caller does not prove its jobs stopped.
