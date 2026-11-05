# Workrun — agent workflow

Kind: **engineering rules**. Read before a coding agent launches a dev stack, browser automation,
checks or dependency installation on the Linux agent host. Consult [Usage](usage.md) for command
semantics and flags. [Setup](setup.md) is only for provisioning or a user-approved budget change.

1. Inspect `pnpm workrun list` and assign an owner and scope to this task, e.g.
   `corral-picker-audit`. Keep shared services in a separate scope with an explicit owner.
   Reuse the configured budget; report missing protection rather than launching unbounded.
2. Run stacks with `start`, and checks, browser/e2e suites and dependency installation with
   `run --heavy`. On a fresh checkout without dependencies, bootstrap with:
   ```sh
   node scripts/workrun/cli.mjs --scope corral-install run --heavy -- pnpm install --frozen-lockfile
   ```
   Application readiness must be observed after a background launch. At most **two live
   development stacks total**, and **one implementation worker**, until explicitly revised.
   Existing non-Linux CI commands remain unchanged.
3. Give browser automation its own named session and keep its fresh daemon inside the task's
   managed job. Verify the actual browser's `/proc/<pid>/cgroup`; the launcher cannot capture a
   pre-existing external daemon. Save evidence outside `/tmp` before teardown.
4. Before handoff, close **that browser session**, stop the task's jobs and require its scoped
   `list --json` to be `[]`. Shared services left running must be reported with owner and name.
   Save code/checkpoints and findings in the repository or GitHub before removing temporary
   worktrees. An agent exiting is not evidence that its servers and browsers stopped.

If an agent fails or is interrupted, its orchestrator performs the same scoped cleanup.
Changing the launcher itself requires [its verification procedure](testing.md).
