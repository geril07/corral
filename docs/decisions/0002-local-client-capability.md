# Authenticate local clients with a per-run capability

**Status:** Accepted. Recorded on 2026-10-31.

## Context

Corral's server can execute commands. A hostile web page may be able to reach a loopback listener,
so listening locally alone does not establish that a client is trusted.

An `Origin`-only gate was not chosen. The
[original design](https://github.com/geril07/corral/blob/59b41dc7e925900520841068d55ebbd588efc194/docs/design.md?plain=1#L46-L52)
records that the desktop loads `file://`, browser development uses another origin and
`Origin: null` is common. This describes Corral's choice, not a claim that `Origin` checks could
never be useful as an additional defense.

## Decision

The server generates a capability for each run and requires it before routing either RPC or a
terminal WebSocket. The capability, not `Origin`, is the gate: a client with the capability is not
denied based on its origin.

## Consequences

The capability is a secret that must be delivered to legitimate clients without leaking it to
other pages or servers. The current delivery and handling rules are in
[Architecture](../architecture.md#local-trust-boundary).

The same OS user is trusted: processes able to read that user's endpoint file can obtain the
capability. This decision does not provide remote authentication or isolation from those processes.

The [transport tests](../../apps/server/src/transport/server.test.ts) check that a missing or wrong
capability is refused, including for a terminal, and that a hostile origin with the capability is
not refused on origin alone. They check the chosen boundary, not the security of every possible
`Origin`-based design.
