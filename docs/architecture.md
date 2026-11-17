# Architecture

The boundaries below constrain changes across Corral's server, clients and agent integrations.
They explain the guarantees to preserve and why they exist; code and tests own APIs and feature
details. UI interaction rules are in [UI kit](ui-kit.md), and engineering rules are in
[Engineering](engineering.md).

## Ownership and lifetime

The long-lived server owns projects, tasks, sessions, PTYs, Git, agent processes and chat state.
Browser and Electron attach using the same web client; closing a client must not stop the server's
work. A future mobile or remote client is another client, not an owner of the server's workspace or
credentials. The local trust boundary below is not remote authentication.

A session persists across a server restart, but its PTY does not: a previously running shell starts
fresh and an agent resumes its native conversation. A stopped or exited session stays stopped.
Settling a task only changes its shelf state; it must not stop sessions or discard work. Returning
it to the active list starts nothing.

Snooze is an overlay on the active state, not a third state: the server stores the wake instant,
and every client derives whether it still applies from that instant, its own clock and the task's
agent statuses. Nothing sweeps an expired snooze, so a stale field is inert rather than a leftover
timer to reconcile.

A generated task title must not overwrite a title the user chose or accepted from an issue.

Server settings are shared between clients; device presentation state is local. Shared model
visibility is a presentation preference, not access control: hiding a model must not change an
existing session. Preferences are stored separately from the hand-edited launch configuration so
saving them does not rewrite that file.

## Terminal and chat

The server ingests terminal output and agent status even with no client attached. Control uses
typed RPC; terminal output uses a separate binary stream with credit-based backpressure. Browsers
cannot apply receive backpressure to WebSockets, and terminal output must not block control
traffic. On attach, the server sends a terminal snapshot before live output. The
[snapshot decision](decisions/0001-terminal-snapshots.md) records the tradeoff.

Terminal and chat are views of the same agent session, not separate conversations. The server
projects native protocols into Corral's chat contract for clients to render; the native agent's
session remains the conversation, not a second authoritative transcript. A task's initial prompt
must not be repeated on resume, which could cause the agent to redo work.

Native agent behavior determines whether views can attach to one live agent server or must hand
off serially. A handoff-only driver must stop the previous writer before starting the next; pi,
for example, does not lock its session file. Switching such a busy session can lose in-flight
state. For a both-live driver, two frontends may instead be clients of the same agent server.
Use the driver's declared capabilities rather than applying one rule to every agent.

OpenCode shares one server among sessions of a Corral run. The first client starts it with that
launch's command, working directory and environment; subsequent clients join it. Sessions use
their own workspace for scoped API work, but the effects of each workspace's native OpenCode
configuration on the shared server have not been established. Changing profile or workspace
handling must account for this shared process. Codex instead uses a server per session. See
[`opencode-server.ts`](../apps/server/src/chat/opencode-server.ts) and
[`chat-driver.ts`](../apps/server/src/chat/chat-driver.ts).

## Workspace data

A task does not own the main checkout or another task's files. Only a worktree owned by the task
may be removed with it. Removal refuses local changes, including ignored files, unless forced, and
never deletes the branch. A failed creation may undo only the worktree and new branch made by that
attempt while no task row owns them; a failure to launch after the row exists keeps the worktree.

Scratch directories and their files survive task removal and failed creation: user data can arrive
even before a task row exists. Scratch is not initialized as Git, and its Git operations must not
walk up into an unrelated ancestor repository. See
[`task-service.ts`](../apps/server/src/tasks/task-service.ts) and
[`changes-rpc.test.ts`](../apps/server/src/changes/changes-rpc.test.ts).

## Profiles and discovery

Profiles are launch choices, **not** sandboxes or account boundaries. An agent inherits the server
environment and can access the user's native agent configuration and credentials. A profile's
nonsecret choices are snapshotted for a session so editing it does not silently change an existing
conversation. Referenced environment values are resolved again at launch; configured literal values
are kept privately for restart. A missing reference refuses the launch instead of silently using
ambient credentials. Resolved secrets must not enter public descriptors, RPC responses or
diagnostics.

Discovery may start native agents and load their plugins or extensions; a metadata-only probe is
not a sandbox and must not mutate a working session. Profile arguments are argv, not a shell
command. Launch and discovery apply the same agent-specific policy so extra arguments cannot take
over Corral's session, mode, resume or prompt controls. Unsupported arguments are refused rather
than silently dropped. See [`instance-args.ts`](../apps/server/src/agents/instance-args.ts) and
[`private-launch.ts`](../apps/server/src/sessions/private-launch.ts).

## Local trust boundary

The server can execute commands, so a hostile web page reaching loopback must not become a client.
The server generates a per-run capability and checks it before routing RPC or terminal sockets.
The same OS user is trusted: this is not isolation from processes that can read that user's
endpoint file. The [capability decision](decisions/0002-local-client-capability.md) records why
`Origin` is not the gate.

Desktop delivers the endpoint through its preload bridge only to the trusted top frame and blocks
unexpected navigation. Browser/dev bootstrap may take the capability from the URL **fragment**,
remove it before routing and keep it paired with its server URL; a stored capability must never
be sent to a different server. Do not put capabilities in request URLs or diagnostic logs. The
dev startup link includes the fragment and must be treated as a secret. See
[`bootstrap.ts`](../packages/client/src/bootstrap.ts) and
[`server-endpoint.ts`](../packages/protocol/src/server-endpoint.ts).

The native servers used for live handoff have their own local boundaries: OpenCode listens on
loopback with its per-run password; Codex uses a per-session Unix socket and a private directory,
not an unauthenticated network listener. These do not isolate code running as the same OS user.
See [`opencode-server.ts`](../apps/server/src/chat/opencode-server.ts) and
[`codex-server.ts`](../apps/server/src/chat/codex-server.ts).

Chat-supplied file paths are untrusted. File reads stay inside the task workspace, are bounded and
are anchored to the inode checked after path resolution; a symlink or file swap between check and
read must not escape the workspace. A local file link is an action to open or preview the file,
not a navigable URL. External links open outside the capability-bearing desktop window. See
[`apps/server/src/files/`](../apps/server/src/files/) and
[`external-url.ts`](../packages/protocol/src/external-url.ts).

## Forge trust

Issue import is a read-only snapshot through the server host's authenticated `gh` or `glab`;
issue text is untrusted task context, not instructions or a shell argument. A host must be trusted
for the provider before import spawns a CLI: public hosts are recognized, and a self-hosted host
must match the project's remote or an operator host setting by host and API port. Local paths are
not remote hosts; a provider selection alone does not establish trust. If the CLI cannot address
the validated endpoint without losing its port, refuse the import rather than contact another
endpoint. An untrusted import is refused without preventing manual task creation.

A GitHub remote alone does not bind the operator's global GitHub tokens to that host: for a
remote-only custom host, strip those tokens and leave host-scoped CLI authentication in place.
Never pass one vendor's token variables to the other vendor's CLI. PR operations share the native
CLI and host-trust machinery, but are not the same operation: an untrusted or unbound destination
strips GitHub tokens rather than applying the issue-import refusal. See
[`issue-import.ts`](../apps/server/src/issues/issue-import.ts),
[`trusted-hosts.ts`](../apps/server/src/issues/trusted-hosts.ts) and
[`changes-service.ts`](../apps/server/src/changes/changes-service.ts).
