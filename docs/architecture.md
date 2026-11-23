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

Chat model and reasoning changes and prompts are ordered per live frontend across clients. A
model-and-reasoning choice may partly succeed: its streamed state is marked pending until both
commands finish, and a reasoning refusal does not undo an accepted model change. Abort and answers
to agent requests do not wait behind that queue, because they may be needed to unblock the agent.

A chat's model and reasoning choice belongs to the session, not to a client: the server keeps it in
the database and applies it at a turn boundary, so a running turn keeps the model it started on and
only a later turn changes. A follow-up message is Corral's queue, not the agent's own: it is stored
with the choice in effect when it was queued and starts as a distinct turn after a settled one.
Initial, ordinary and queued prompts are recorded before dispatch. A later turn and model application
need a delivery receipt and a reliable boundary; either may arrive first. A boundary correlated to
the prompt also proves delivery if the receipt was lost. pi checks idle state after `agent_settled`,
invalidating the check for new activity and waiting for compaction, retries and steer acknowledgements.
Codex matches `turn/completed` to the `turn/start` response's turn ID; Claude matches the input UUID
on its result. OpenCode matches inbox delivery to the prompt ID, then waits for a later durable
execution outcome; shutdown interruption is not an outcome because the native execution may resume.
Missing or ambiguous evidence pauses later turns rather than treating a stale event as proof. A refusal
is distinct from a transport failure, which may have delivered the prompt. The
server never retries an uncertain prompt automatically. A crash or frontend exit leaves in-flight
text visible, distinguishing unknown delivery from accepted delivery with an unknown boundary.
Stopping a frontend is not proof that a shared native server stopped its turn. On pi's exclusive
handoff, the previous writer is stopped before a replacement opens the session. The replacement may
unblock later turns only after a generation-checked native idle probe; this neither attributes the
old prompt to a history item nor proves its outcome or reverses side effects. Its text and delivery
uncertainty stay visible, and formerly queued messages are not restarted. A busy or unanswered probe,
and shared native servers without a correlated recovery boundary, remain blocked. Claude Code 2.1.330 echoed prompt UUIDs in
two isolated turns with a local model stub; a version or turn without an echo remains unconfirmed.
This is at-most-once dispatch from Corral, not exactly-once execution.
The user's last explicit thinking level is remembered per agent, profile and model; a level the live
driver no longer offers stays remembered without being applied or replaced, and a failed discovery
is not evidence that it was removed. While the live report does not offer it, the session state says
so and the server refuses to start a turn on that selection rather than delivering it on another
level. The choice is separate from the launch snapshot on purpose: the snapshot records how the
conversation was opened, while these rows record what its next turn should run. pi resumes without
the snapshot's model flags; otherwise the original launch choice can override the conversation's
subsequent choice. A selection without an explicit or remembered level sends no thinking command;
it does not claim that a native default is known or that an existing level was reset. Pi 1.5.2 and
1.6.0 reset to the configured native level when `set_model` runs, but the reported level rather
than an assumed cross-version reset remains the evidence for the running model.
Before starting a pi or Codex chat, explicit levels are saved only against a fresh scoped catalog;
the live driver confirms the model and level again before the first prompt. A remembered level is
restored only when the new frontend reports that it is offered. Other agents do not yet expose this
pre-launch thinking path. A session row and its selection precede frontend startup so a fast initial
prompt cannot outrun their durable records.

Codex 0.166.0's `turn/start` model and effort overrides affect subsequent turns as well. In an
isolated local-provider probe, an omitted effort inherited the previous turn's explicit effort even
after changing models. The app-server also forwarded both `off` and an arbitrary effort that its
catalog did not offer; a successful turn start is therefore not validation of an effort. Codex
validates a captured choice against its live model list before dispatch and sends it on that turn,
without applying a later choice to a running turn or steer. Omission does not claim a reset to the
catalog default. A model-only turn is refused when its inherited effort is unknown or not offered;
the user can choose an offered effort. A configured launch with no selection stays native.

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
