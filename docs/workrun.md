# Local workloads in Corral

Kind: **engineering rules**. Corral's use of [workrun](../scripts/workrun/README.md) on the Linux
agent host. The tool's [usage](../scripts/workrun/docs/usage.md) owns CLI semantics, not project
policy. Non-Linux CI commands are unchanged.

## Entrypoint and group

Use the repository-pinned toolchain. Invoke `pnpm workrun` from the assignment's checkout; before
dependencies exist, invoke `node scripts/workrun/cli.mjs`. These are Corral entrypoints, not
globally installed commands.

Use group **`corral` across this project's worktrees**. Give concurrent jobs distinct assignment
names; e.g. `issue135-dev` and `issue135-check`. Budget values belong to the host owner:
reuse the configured budget rather than running setup or raising limits for a slow command.

```sh
node scripts/workrun/cli.mjs --group corral run -- pnpm install --frozen-lockfile
pnpm workrun --group corral run -- pnpm typecheck
pnpm workrun --group corral start issue135-dev -- pnpm dev --fake-agents
pnpm workrun --group corral run --name issue135-check --heavy -- pnpm check
```

## Corral's heavy classification

**Only full test suites use `--heavy` in this project.** Other workloads still run under the
same CPU/RAM budget. Classification is not authorization to run an otherwise out-of-scope suite.

| Workload                                                                       | Heavy |
| ------------------------------------------------------------------------------ | ----- |
| Full `pnpm test`, `test:browser`, `test:e2e`, `test:contracts`, `test:workrun` | Yes   |
| `pnpm check` (includes the full Node suite)                                    | Yes   |
| Selected test files or a filtered test case                                    | No    |
| Dependency installation, typecheck, lint, format, build                        | No    |
| Development stack or seed command                                              | No    |

Test selection and required gates remain in [AGENTS.md](../AGENTS.md#verification); this table
only chooses admission. The shared workrun budget applies without an additional host-specific
test-worker or shard limit.

Let workrun wait for heavy capacity instead of adding sleep/retry loops. Give the invoking tool
enough time for waiting plus execution and cancel that invocation to withdraw a waiter.

## Verifying workrun changes

The ordinary Node gate skips the real-systemd suite. After the host owner has
[configured workrun](../scripts/workrun/docs/setup.md), run this opt-in suite with CPU/RAM
headroom when changing the launcher or its config:

```sh
pnpm workrun --group corral run --name workrun-tests --heavy -- pnpm test:workrun
```

Before integrating such changes, run `pnpm check` and this suite on the final tree. The suite
uses separate groups from the runner's heavy slot, preserves the shared budget and cleans up its
own jobs and configuration. Check that its jobs are absent afterwards. The tool's
[verification contract](../scripts/workrun/docs/testing.md) owns the test safety rules.

For CLI behavior and ownership limits, read [Usage](../scripts/workrun/docs/usage.md); host
provisioning and resource settings belong to [Setup](../scripts/workrun/docs/setup.md).
