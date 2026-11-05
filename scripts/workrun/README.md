# Workrun

Kind: **tool documentation**. A general-purpose Linux command and background-job launcher over
user systemd, cgroup v2 and util-linux flock. Node.js uses built-in modules; there is no additional
runtime package, persistent workrun daemon, application database or PID registry.

| Task                                                  | Read                            |
| ----------------------------------------------------- | ------------------------------- |
| Invoke the CLI, inspect jobs, wait or cancel          | [Usage](docs/usage.md)          |
| Provision a host or configure budgets and heavy slots | [Setup](docs/setup.md)          |
| Change or verify the launcher                         | [Verification](docs/testing.md) |

The tool owns group/job semantics, resource enforcement, admission and lifecycle. The integrating
project chooses its entrypoint, group/job naming, commands classified as heavy, development
isolation and agent workflow. Those choices are not inferred by workrun.
