# Workrun — verification contract

Kind: **tool documentation**. For launcher maintainers. The test-runner commands and gate policy
belong to the integrating repository; the invariants below belong to workrun.

Real-interface tests exercise the CLI against user systemd, cgroups and flock after explicit host
[setup](setup.md). Tests use unique groups, preserve the shared host budget and remove only their
own jobs, configuration and temporary data. All groups still share resources: use host headroom,
not group names, as evidence that a resource probe is safe.

Required behavior:

- Literal argv, cwd, environment and payload exit status, including exit 75.
- Background lifetime, invocation-owned cancellation and descendant cleanup.
- Shared per-group admission across directories, independent groups, concurrent slots, waiting,
  cancellation and capacity held until all descendants and deactivating jobs are gone.
- Persisted settings and existing managed files survive changes that do not replace them.
- Kernel budget refusal and CPU/memory enforcement, including a deliberate bounded **64 MiB**
  group OOM. The host still needs headroom for this probe.

Use observable readiness/exit/state signals with deadlines, not bare sleeps. Admission probes
must use groups separate from the test runner's own group when the runner occupies heavy capacity.
Assert cleanup on failure as well as success; ending the caller does not prove its jobs stopped.
