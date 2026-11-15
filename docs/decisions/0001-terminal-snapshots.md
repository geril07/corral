# Restore terminals from server snapshots

**Status:** Accepted. Recorded on 2026-10-30 before Corral's headless terminal was committed.

## Context

Clients can attach to a running terminal after missing output. They need the current screen,
scrollback, cursor and modes, including a full-screen application's alternate screen; rendering
only a recent tail of raw output can omit the sequences that established that state.

## Decision

Keep a headless terminal on the server and send a serialized state snapshot when a client attaches
or needs to resynchronize, then continue with live output. The server also ingests status without
an attached client.

The [original decision record](https://github.com/geril07/corral/blob/70599089274b740d3c38a5e5d6a6b4704f3417f1/docs/design.md?plain=1#L19-L20)
contrasted this with raw-output replay and cited Orca's headless terminal as prior art. It asserted
that replay did not reliably restore full-screen applications, but did not include a comparative
test or specify the retained output and resize history. This is not evidence that replaying a
complete history with its terminal resizes could never work.

## Consequences

The server maintains terminal state even when no client is attached. Serialization must carry
screen state and modes, and incomplete parser input needs separate handling across the snapshot
boundary. The [headless terminal](../../apps/server/src/terminals/headless-terminal.ts) and
[pending input tail](../../apps/server/src/terminals/pending-input-tail.ts) own those details.

[Snapshot tests](../../apps/server/src/terminals/headless-terminal.test.ts) cover alternate screens,
normal scrollback and splits within output. [Stream tests](../../apps/server/src/transport/terminal-stream.test.ts)
cover attaching to a full-screen app and the boundary between the snapshot and live output. They
test the chosen approach, not a comparison with raw replay. The decision does not preserve a PTY
across a server restart; current lifetime and flow-control rules are in
[Architecture](../architecture.md).
