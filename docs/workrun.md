# Workrun

Kind: **engineering rules**. A general-purpose Linux launcher for scoped commands and background
services, using systemd for lifecycle/resource limits and flock for heavy-job admission.

Read the part for your task:

| Task                                               | Read                                  |
| -------------------------------------------------- | ------------------------------------- |
| Run commands, inspect logs, stop services          | [Usage](workrun/usage.md)             |
| Launch and clean up workloads as a coding agent    | [Agent workflow](workrun/agents.md)   |
| Provision a machine or change shared/scope budgets | [Setup and budgets](workrun/setup.md) |
| Change or verify the launcher itself               | [Launcher tests](workrun/testing.md)  |

An already configured host needs no setup step before ordinary use. Budget changes are deliberate
host changes, not an automatic response to a failed command.
