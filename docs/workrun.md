# Workrun

Kind: **engineering rules**. Linux command and background-job launcher: one shared CPU/RAM
budget, optional group budgets, and per-group heavy admission. A group normally represents a
project; jobs distinguish assignments and worktrees.

| Task                                                           | Read                                      |
| -------------------------------------------------------------- | ----------------------------------------- |
| Run, inspect or stop a job; decide whether it is heavy         | [Usage](workrun/usage.md)                 |
| Assign agent jobs, coordinate worktrees and hand off resources | [Orchestration](workrun/orchestration.md) |
| Provision the host or deliberately change budgets/admission    | [Setup](workrun/setup.md)                 |
| Change or verify the launcher                                  | [Verification](workrun/testing.md)        |

Configured hosts need no setup before ordinary use. Resource changes are host-owner decisions,
not an automatic response to a slow or failed command.
