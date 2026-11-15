# Corral

Keyboard-first workspace for running coding agents in terminals. A long-lived server owns the
work; browser and desktop clients attach to it.

On the shared Linux agent host, read [workrun](docs/workrun.md) before running local workloads.
For development, install the pinned tools and dependencies, then start the local stack:

```sh
mise install
pnpm install
pnpm dev
```

Development uses checkout-local state rather than the installed app's data. For verification and
change rules, start with [AGENTS.md](AGENTS.md); product decisions and engineering rules are in
[Design](docs/design.md) and [Engineering](docs/engineering.md).
