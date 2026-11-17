# Engineering

Rules for changing Corral. System boundaries are in [Architecture](architecture.md); the
applicable checks are selected by [AGENTS.md](../AGENTS.md#verification).

## Dependencies

- A dependency the project must pay for is not allowed. A proprietary package free of charge is
  allowed; record its license and the reason for choosing it when adding it.
- The Claude Agent SDK is a proprietary but free-of-charge package, not an open-source
  dependency; its license points to Anthropic's terms. It drives the user's installed CLI rather
  than the SDK's optional platform copies. The excluded copies are listed in
  `pnpm-workspace.yaml`.
- SQLite uses Node's built-in binding to avoid another native module beside node-pty.

## Boundaries

- `packages/protocol` owns shared wire contracts and depends on no internal package. Server and
  client depend on it; a client must not import server implementation or types. The desktop shell
  uses the endpoint contract and starts the server. Lint enforces the dependency direction.
- Organize server code by domain. Keep parsing and state transitions separate from IO, and RPC
  handlers thin: validate, call the domain and map errors. Client stores remain framework-agnostic.
- Terminal output goes directly to xterm, not through React state.
- The server's single-instance lock uses the state directory, while its database and chat writer
  records use the data directory. Different state directories pointing at the same data directory
  can start competing servers; one machine with one state directory is the supported shape.
  Dev uses checkout-local state and data to avoid the installed app.

## Data and external processes

- Use [`gitRead`](../apps/server/src/git/git.ts) for read-only Git operations. A `status` or `diff`
  can otherwise rewrite the index; literal path handling also prevents a file name becoming a
  pathspec. Git writes require an explicit action, not a read-model refresh; remote writes also
  revalidate the confirmed destination.
- Use the bounded process runner for Git and native forge CLIs. A child can leave descendants
  holding its pipes; deadlines and process-group cleanup must not depend on pipe closure. The
  runner and native CLI policy are in [`apps/server/src/process/`](../apps/server/src/process/)
  and [`apps/server/src/cli/`](../apps/server/src/cli/).
- Never edit a shipped database migration. A step adding a column checks for it first: an
  unreleased development database can already have the target shape. See
  [`database.ts`](../apps/server/src/storage/database.ts).
- Client and server exchange a protocol version and refuse mismatches. Bump it when an older
  daemon would silently ignore a change; preserve a visible refusal rather than mutating through
  an incompatible connection. The version is defined in
  [`handshake.ts`](../packages/protocol/src/handshake.ts).

## Testing

Test behavior a user or caller can observe, at the lowest layer that catches the regression.
Extend an existing case when it fits. Do not maintain tests that restate the implementation or
what types guarantee.

Use real SQLite, filesystem, Git, sockets and PTYs in isolated temporary state. Fake external
agents and paid or nondeterministic services; real CLI contract tests are opt-in and do not prove
paid model behavior. Wait for observable signals with deadlines, not bare sleeps. Tests clean up
their own processes, sockets and files even on failure. Servers use port 0 and isolated data.
Parser tests cover malformed input and chunk boundaries. A flaky test is a defect, not a reason
to add retries.

Examples from the repository root:

```sh
pnpm exec vp fmt --check <file>
pnpm exec vp lint <file>
pnpm --filter @corral/server typecheck
pnpm exec vp test run --project node <test-file>
pnpm exec vp test run --project browser <test-file>
```

Browser tests use real Chromium; Electron tests exercise the desktop app. A single-file browser
run does not prove suite isolation: files within a shard share a server. The performance suite is
separate from the browser gate so its timing is not measured under concurrent shard load.

On the Linux agent host, use [workrun](workrun.md) for local workloads. The project-specific
real-systemd check for launcher changes is also there.

## Documentation

Internal docs hold decisions and reasons, cross-component constraints and traps that code alone
does not make apparent. A local reason belongs beside its code. Link to the implementation
instead of cataloguing its fields, methods, constants or control flow. Update a documented
invariant when it changes; ordinary implementation changes do not require a documentation edit.
An architecture decision record may retain the context, alternatives and consequences of a
significant choice when that history is useful; mark it when superseded. Current constraints live
in the relevant guidance, not in an obsolete decision record. Work status, plans and research
artifacts belong in issues, PRs or commits.

### Comments

A comment must carry information the code cannot: the reason for this shape, the trap it avoids,
an invariant, a measured external behavior, or the requirement a test pins. If deleting it loses
nothing, delete it and let names, types or structure say it instead.

Keep: the alternative rejected and why; what breaks on removal, reordering or retry; an external
quirk with the version that showed it; a module's responsibility; a test's requirement or edge
case, stated once; a suppression's reason after `--`.

Drop: a sentence the names and types already say; control-flow narration; changelog or review
history; commented-out code; `TODO`/`FIXME` (file an issue); section banners inside a function.
A test comment states what the test guarantees, not how; the test name is not repeated.

References name a symbol, or at least its file; never a line range, which rots silently. A task or
decision code belongs to the issue that defines it; cite the issue number instead.
