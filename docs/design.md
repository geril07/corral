# Design

Corral is a keyboard-first workspace for coding agents. This document records product
decisions and cross-component constraints; the implementation and tests own current APIs and
details. UI direction and primitive boundaries are in [UI kit](ui-kit.md).

## Architecture

The long-lived server owns projects, tasks, sessions, PTYs, Git, agent processes and chat state.
The browser and Electron use the same web client; Electron adds the native shell and server
startup. Closing a client must not stop the server's work. A future mobile or remote client is
another client of the server, not a second owner of the workspace or agent credentials; remote
authentication is not provided by the local trust boundary below.

Control uses typed RPC; an attached terminal uses a separate binary stream with credit-based
backpressure. Browsers cannot apply receive backpressure to WebSockets, and terminal output must
not block other control traffic. The server maintains a headless terminal and sends a snapshot
before live output on attach: replaying raw output alone does not reliably restore full-screen
TUIs. Status is also ingested on the server so it works without an attached client.

The server projects each agent's native protocol into Corral's chat contract and streams a
snapshot plus events. Clients render that contract rather than implementing provider protocols.
The native agent's session remains the conversation: Corral does not make a second authoritative
transcript.

## Domain model

- A **project** names a Git repository on the server. Different paths into the same main working
  tree refer to the same project.
- A **task** is the unit of work. A workspace and optional branch belong to it, rather than
  defining the user's organization. A task has sessions; its primary agent session supplies the
  task's status. Auxiliary shells and agents do not set that status.
- **Settle** moves a task to a shelf; it does not stop sessions or discard work. Starting work in
  a settled task makes it active; un-settling alone starts nothing.

### Sessions

A session is a shell or agent belonging to a task. A loose terminal is not a session. A session
persists, but its PTY does not: after a server restart a previously running shell starts fresh and
an agent resumes its native conversation. A stopped or exited session stays stopped.

### Task creation and workspace

A task may use the project's main checkout, a task-owned worktree, or a scratch directory with no
project. The server API and the routed composer need not expose the same choices: do not infer
an available UI action from an RPC alone.

Scratch creation makes a distinct directory under the server's data directory and does not
initialize Git. Removing the task or failing after the directory was created keeps the directory
and its files: even a failed create may have acquired user data. Scratch Git operations must not
walk up into an unrelated ancestor repository. See
[`task-service.ts`](../apps/server/src/tasks/task-service.ts) and
[`changes-rpc.test.ts`](../apps/server/src/changes/changes-rpc.test.ts).

Only a worktree owned by the task may be removed with it. Removal refuses local changes, including
ignored files, unless forced, and never deletes the branch. A failed creation may undo only the
worktree and new branch made by that attempt while no task row owns them; a failure to launch
after the row exists keeps the worktree. A main checkout and another task's files are never
owned by this task.

A prompt-only task gets an immediate seed title and can receive a generated one. A title the user
typed or accepted from an issue must not be replaced by a later naming result. The prompt is
delivered on the first conversation start, not repeated on resume.

## Terminal and chat

Terminal and chat are views of the same agent session, not separate tasks or conversations.
Native agent behavior determines whether views can attach to one live agent server or must hand
off serially. A handoff-only driver must stop the previous writer before starting the next; pi,
for example, does not lock its session file. Switching such a busy session can lose in-flight
state. For a both-live driver, two frontends may instead be clients of the same agent server.
Do not turn either rule into a blanket claim about all drivers; use their declared capabilities.

OpenCode shares one server among sessions of a Corral run. The first client starts it with that
launch's command, working directory and environment; subsequent clients join it. Sessions use
their own workspace for scoped API work, but the effects of each workspace's native OpenCode
configuration on the shared server have not been established. Changing profile or workspace
handling must account for this shared process. Codex instead uses a server per session. See
[`opencode-server.ts`](../apps/server/src/chat/opencode-server.ts) and
[`chat-driver.ts`](../apps/server/src/chat/chat-driver.ts).

## Profiles and model discovery

Settings come from the server: built-in defaults, global configuration, then project overrides.
Device presentation state is local to the client. A launch profile's nonsecret choices are
snapshotted for a session; editing the profile must not silently change an existing conversation.
Referenced environment values are resolved again at launch, while configured literal values are
kept privately for restart. A missing reference refuses the launch instead of silently using
ambient credentials.

Profiles are launch choices, **not** sandboxes or account boundaries. An agent inherits the
server environment and can access its user's native agent configuration and credentials.
Resolved secrets must not enter public descriptors, RPC responses or diagnostics. Discovery may
start native agents and load their plugins or extensions; a metadata-only probe is not a sandbox.
It must not mutate a working session.

Profile arguments are argv, not a shell command. Launch and discovery apply the same
agent-specific policy so an extra argument cannot take over Corral's session, mode, resume or
prompt controls. Unsupported arguments are refused rather than silently dropped. See
[`instance-args.ts`](../apps/server/src/agents/instance-args.ts) and
[`private-launch.ts`](../apps/server/src/sessions/private-launch.ts).

Model visibility and favorites are presentation preferences shared between clients, not access
control. Hiding a model must not rewrite the model or state of an existing session. Preferences
are stored separately from the hand-edited launch configuration so Settings can save them without
rewriting that file.

## Local trust boundary

The server can execute commands, so a hostile web page reaching loopback must not become a client.
The server generates a per-run capability and checks it before routing RPC or terminal sockets.
The same OS user is trusted: this is not isolation from processes that can read that user's
endpoint file.

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

## Keyboard and interaction

Corral is keyboard-first, but ordinary typing and IME composition belong to the focused input.
Terminal keys belong to the PTY; the configurable prefix provides a way out. Browser-reserved
shortcuts are not a promise the web client can keep.

Dialogs and menus retain accessible keyboard and focus behavior; dismissing one returns focus to
its opener or the active work surface. Opening Settings must not destroy the mounted workspace,
terminal attachments or drafts. Failed creation and refused sends retain the user's input.
