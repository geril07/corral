# Corral — verify workrun changes

Kind: **engineering rules**. Repository-specific commands and release gates for launcher changes.
The tool's [verification contract](../../scripts/workrun/docs/testing.md) owns required behavior;
[project policy](../workrun.md) owns heavy classification.

The ordinary Node gate runs the model/config tests and skips the real-systemd suite. To opt in
after the host owner has [configured workrun](../../scripts/workrun/docs/setup.md):

```sh
pnpm workrun --group corral run --name workrun-tests --heavy -- pnpm test:workrun
```

`pnpm test:workrun` enables `WORKRUN_SYSTEMD_TEST=1` and runs `scripts/workrun` in the Node
project with one test worker. The suite's unique groups are separate from the outer project's
heavy capacity. It preserves the shared budget and cleans up its own jobs/configuration.
Choose a time with shared CPU/RAM headroom.

Before integrating launcher/config changes, run `pnpm check` and the opt-in suite on the final
tree. Browser/Electron suites are required only when their app surfaces change. Record commands,
counts, skips and durable log paths in the PR; check that test-owned jobs are absent afterwards.
