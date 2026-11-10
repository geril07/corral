# Named agent instances

A named agent instance is a launch profile: it names an agent, its executable, optional launch
arguments, environment variables and, where that agent supports it, a native model/provider for one
conversation. Instances live in the server-owned `config.toml`
(`$CORRAL_CONFIG_DIR/config.toml`, else `$XDG_CONFIG_HOME/corral/config.toml`, else
`~/.config/corral/config.toml`). Editing the file is supported; the server watches it and pushes
safe descriptors to every client.

Instances are explicit launch choices, **not a sandbox or an account boundary**. The agent still
inherits the server's environment and its own credential/config files (`~/.claude`, `~/.codex`,
pi auth, OpenCode providers). See [Security](#security).

## Configuration

```toml
[keys]
prefix = "alt+a"

[profiles.claude-gateway]
name = "Claude via gateway"
agent = "claude"
model = "claude-sonnet-4-5"
env = [
  { targetName = "ANTHROPIC_BASE_URL", fromEnv = "CLAUDE_GATEWAY_URL" },
  { targetName = "ANTHROPIC_AUTH_TOKEN", fromEnv = "CLAUDE_GATEWAY_TOKEN" },
]
```

- `name` is required, at most 80 characters.
- `agent` is one of `claude`, `codex`, `pi`, `opencode`.
- `model` and `provider` are optional native identifiers.
- `command` is an optional absolute executable path; empty or absent falls back to the agent's
  configured executable. It is the executable sessions, restarts and discovery run. `args` is an
  optional array of argv strings, not a shell command; see
  [Instance launch arguments](#instance-launch-arguments).
- `enabled` defaults to true; false removes the instance from every picker and refuses a **new**
  launch with `LAUNCH_FAILED` naming the disabled instance. An existing session of it still stops
  and resumes.
- `env` entries have `targetName` and exactly one of `fromEnv` (a server environment name) or
  `value` (a literal stored privately in the server config). Literal values are never sent in the
  public descriptor. Protect the file accordingly.
- The profile id (the table key) is letters, digits, `.`, `_` or `-`, starting with a letter or
  digit, at most 64 characters. Quote an id that contains a dot
  (`[profiles."team.claude"]`); an unquoted dot makes TOML nested tables.

A profile is **all-or-nothing**: an unknown key, wrong type, reserved variable, invalid id or an
unsupported model/provider drops the whole profile. Other profiles and `[keys]` still apply.
Each issue is a `ConfigProblem` at path `profiles.<id>` when the id is valid. An invalid id is
reported at `profiles`, because echoing the key could echo a secret. Messages never quote values
from the file. A profile that is dropped is not selectable, so the UI cannot claim a launch that
will not happen.

Every valid profile has a content `revision` (12 hex characters) over its id, name, agent,
model, provider, command, args, enabled state and private environment definition. It does not
include literal values in the public descriptor. Literal values are keyed with an in-memory
per-server-run secret before revision hashing to prevent offline guessing; revisions for instances
with literal values therefore change when the server restarts, even if the file did not change.

### Instance launch arguments

`args` is an argv array, never a shell line. Corral prepends it to the flags it owns, so an instance
can configure its agent but cannot take over the session, mode, resume or prompt controls:

| Agent    | Instance `args` at launch                                                               |
| -------- | --------------------------------------------------------------------------------------- |
| pi       | Accepted from a fixed policy: the non-owning switches and values in `instance-args.ts`. |
| claude   | Refused when nonempty (`LAUNCH_FAILED`); the chat driver owns the argv.                 |
| codex    | Refused when nonempty (`LAUNCH_FAILED`); the app-server and TUI argv are Corral's.      |
| opencode | Refused when nonempty (`LAUNCH_FAILED`); the root TUI argv is Corral's.                 |

The pi policy accepts `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-themes`,
`--no-context-files`, `--no-tools`, `--no-mcp`, `--offline` and `--verbose`, plus
`--extension`, `--skill`, `--prompt-template` and `--theme` with one non-flag value. Model and
provider stay the typed `model`/`provider` fields; `--mode`, `--session-id`, `--resume`, prompts
and any equals form are refused. A refused argv spawns nothing and names the policy violation
without quoting values. Native model discovery applies the same policy and the same order, so a
picker cannot discover models through a launch the session would refuse.

### Task defaults, naming and project overrides

`[tasks]` holds what a new task starts with, `[naming]` picks the agent that generates task
titles, and `[projects."<absolute repository path>"]` overrides `[tasks]` for one repository.

```toml
[tasks]
agent = "claude" # default agent for a new task
profile = "claude-gateway" # a [profiles.<id>] id; wins over agent
model = "claude-sonnet-4-5" # overrides the profile's model
workspace = "new-worktree" # main-worktree (default) | new-worktree
worktree-root = "~/corral-worktrees" # absolute or ~-relative; default <data dir>/worktrees
branch-prefix = "corral/" # prefix of a branch a task creates; default empty
slug-mode = "title" # title (default) | generated
view = "terminal" # explicit opt-out; chat is the default where an agent has a driver

[naming]
profile = "claude-gateway" # or agent, plus its optional model
timeout-seconds = 8 # whole seconds, at least 1; default 8

[projects."/home/me/code/app"]
workspace = "main-worktree" # the same keys as [tasks]
```

- Every task value resolves in layers: built-in default, then `[tasks]`, then the project's
  table. The server sends the resolved values with the layer each came from; Settings shows
  them.
- A project without a `[projects]` table uses `[tasks]`. A project key is the absolute
  repository path as the server stores it — the main working tree's real path, so a symlinked
  path resolves to its target. A path that does not exist yet is kept as written; one that
  exists but cannot be resolved (permissions, a symlink loop) is a problem rather than a key
  that would never apply. Keys resolve when the file is read, so a repository or symlink that
  appears later picks its table up on the next save of the file, not before. Quote keys that
  contain dots.
- `profile` wins over `agent`, and `model` overrides the profile's model. A model is checked
  against the agent that will run it (the profile's agent when a profile wins), so a model the
  agent has no flag for is a problem. An `agent` written in the same table as a profile that
  launches another agent is reported and dropped: a launch refuses that pair. The same check
  runs after the layers are applied, so a profile from one layer that meets a contradicting
  agent from another (say `[tasks] agent` plus a project `profile`) is reported at the
  project's key and the agent is dropped.
- `worktree-root` is an absolute path or below `~` (the server's home directory). A
  `~`-relative root may not climb out with `..`; the server expands `~` when it uses the root,
  and the file keeps the value as written.
- `[naming]` needs a profile or an agent (with an optional model). A missing or empty section
  means no generation: tasks keep the prompt-derived seed title (`design.md` decision 16). It
  runs that agent in its non-interactive mode, with no session saved, in a temporary directory:
  claude `-p --no-session-persistence --tools ""`, pi `-p --no-session --no-tools`, codex
  `exec --ephemeral --skip-git-repo-check --ignore-user-config --ignore-rules -s read-only -c
  approval_policy=never`. Claude and pi disable tools outright. Codex has no flag that removes its
  read-only tools: with the global config and execpolicy rules ignored, the user's MCP servers and
  hook/notify commands do not run; its shell cannot write and it cannot ask for approval. It can
  still read whatever the server's user can read, so the empty temporary directory only keeps its
  relative work away from the repository. OpenCode cannot be a naming runner: `opencode run`
  always saves a session (2.2.5), so an OpenCode profile or agent in `[naming]` is a
  `ConfigProblem` and naming stays off.
- `view` is `chat` (the built-in default) or `terminal`. `chat` is accepted where this build has a
  chat driver for the agent (`chat.capabilities`). After the layers resolve, a `chat`
  view whose agent has no driver becomes `terminal`, and the file reports a **warning** at the
  entry responsible — `tasks.view`, or the project table whose own agent or view caused it. With
  no agent pinned the view stays `chat`, and the **composer** applies the rule to the agent the
  user picks there. Task creation and the add-agent UI (`prefix s`) use this effective default
  and offer an explicit view choice. The `sessions.start` API still defaults an omitted `view`
  to terminal; the UI passes its choice explicitly. Restart the long-lived server after upgrading
  to load changed built-in defaults; explicit terminal settings are not migrated.
- Unknown keys and invalid values are `ConfigProblem`s that drop only that entry; the rest of
  the table still applies. A `profile` that names no valid profile is such a problem, and two
  project keys that resolve to one repository are reported rather than merged.

### Agent settings

`[agents.<kind>]` says what Corral offers and runs for one agent. It has **no per-project layer**:
an agent is a property of the machine, not of a repository. It does not repeat a launch profile's
model, provider or environment references; those stay in `[profiles.<id>]` and `[tasks]`.

```toml
[agents.pi]
enabled = true # false hides it from every picker and refuses a new launch; default true
command = "/opt/pi/bin/pi" # absolute path replacing the PATH lookup; default the agent's name
```

- `enabled` (default `true`) takes the agent out of the composer's agent picker, the new-session
  agent picker and every profile that launches it. `sessions.start` refuses a new launch of a
  disabled agent with `AGENT_DISABLED { kind }`; an existing session of it can still be stopped
  and resumed. `[tasks] agent`, `[naming] agent` and a profile that name a disabled agent are
  reported and dropped, like any other invalid entry, so no default points at an agent nobody can
  pick.
- `command` (default the agent's own name) is the executable a launch runs: sessions in either
  view, and a `[naming]` run. It must be an **absolute path** — a bare name or a relative path
  would be resolved from the server's own working directory, not from the task's workspace — and
  may not contain control characters. An invalid `command` is reported at
  `agents.<kind>.command` and dropped alone; `enabled` beside it still applies.
- Unknown agent kinds and unknown keys are problems too (`agents.grok`, `agents.pi.model`). The
  table is not all-or-nothing: each agent and each key is independent.
- The executable is checked before every launch with the same lookup the spawn uses. A command
  that is not executable fails the launch with `AGENT_NOT_FOUND { command }`.
- Settings names every agent, the command a launch would run and where it came from, whether the
  server found it, and whether this build has a chat driver for it (`ConfigState.agents`).

### The editor for local file links

A path in chat opens in the user's editor (`docs/ux.md`, **Local links in chat**). `[editor]` names
that editor. Like `[agents.<kind>]` it describes the machine, not a repository, so it has **no
per-project layer**.

```toml
[editor]
command = "code --goto {file}:{line}:{column}" # default "": $VISUAL, then $EDITOR decide
```

- The precedence is **`[editor] command`, else `$VISUAL`, else `$EDITOR`** (the order X11 and most
  CLIs use), and a value that is empty or only whitespace opts out of its layer. Nothing
  configured — or nothing usable — is a refusal with a reason, `EDITOR_UNSET { reason }`, not a
  silent fallback: Corral does not hand a source file to the desktop's file association, which is
  usually not the user's editor and cannot carry a line.
- `command` is a command line, split like a shell would for quoting and backslashes, with no
  expansion: `command = "'/opt/My Editor/edit' --wait"`. A bare name is looked up on the server's
  `PATH`, because `$EDITOR=nvim` is the same shape.
- `{file}`, `{line}` and `{column}` are filled in from the link (`src/app.ts:12:3`); a command with
  no placeholder gets the file's absolute path appended, which is what `$EDITOR=nvim` relies on.
  Any other placeholder is a problem, and the entry is dropped rather than run wrong.
- The editor runs as a terminal in the task's workspace, so a terminal editor has a PTY and a GUI
  editor detaches from it. It is a loose terminal (Scratch), not a session: a task's terminals
  keep one owner (`design.md`, **Session**).
- An invalid entry drops **only itself**, is reported at `editor.command`, and the environment
  decides instead. A command that is not executable fails the click with
  `EDITOR_NOT_FOUND { command }`.

### Safe examples per agent

Claude Code has `--model` and no provider flag. Route it with environment references:

```toml
[profiles.claude-gateway]
name = "Claude via gateway"
agent = "claude"
model = "claude-sonnet-4-5"
env = [
  { targetName = "ANTHROPIC_BASE_URL", fromEnv = "CLAUDE_GATEWAY_URL" },
  { targetName = "ANTHROPIC_AUTH_TOKEN", fromEnv = "CLAUDE_GATEWAY_TOKEN" },
]
```

Codex has `-m/--model` and `-c model_provider=<native id>`. Corral never passes
`-p/--profile` and never writes `$CODEX_HOME`. The provider must already exist in the user's
Codex config (`model_providers.<id>`, including its `env_key`/wire settings); Corral only selects
it and does not define or validate it beforehand.

```toml
[profiles.codex-work]
name = "Codex work provider"
agent = "codex"
model = "gpt-5-codex"
provider = "work"
```

pi takes `--provider` with `--model`; the model id may carry `provider/id` and `:thinking`.
A provider without a model is rejected.

```toml
[profiles.pi-anthropic]
name = "pi on Anthropic"
agent = "pi"
provider = "anthropic"
model = "anthropic/claude-sonnet-4:high"
env = [{ targetName = "ANTHROPIC_API_KEY", fromEnv = "PI_ANTHROPIC_KEY" }]
```

OpenCode 2.1.4 has no model or provider flag on the root TUI command used by Corral, so its
profiles are env-only:

```toml
[profiles.opencode-team]
name = "OpenCode with the team key"
agent = "opencode"
env = [{ targetName = "OPENAI_API_KEY", fromEnv = "TEAM_OPENAI_KEY" }]
```

### Capability matrix

| Agent    | `model` | `provider`                       | Launch arguments                    |
| -------- | ------- | -------------------------------- | ----------------------------------- |
| claude   | yes     | no (route with env refs)         | `--model <id>`                      |
| codex    | yes     | yes, an existing native provider | `-m <id>`, `-c model_provider=<id>` |
| pi       | yes     | yes, requires `model`            | `--provider <id> --model <id>`      |
| opencode | no      | no                               | none (profile is env-only)          |

Unknown model/provider ids are not discovered or guessed. Codex's provider is checked only by
Codex itself, at request time. The **Launch arguments** column is the argv Corral adds for that
choice; an instance's own `args` is separate and subject to the per-runtime limits above.

The same table is exported for clients, so a picker does not duplicate the rules:

```ts
import { AGENT_LAUNCH_CAPABILITY } from "@corral/protocol/config";

AGENT_LAUNCH_CAPABILITY.opencode;
// { model: false, provider: false, providerRequiresModel: false }
```

Each entry has `model`, `provider` and `providerRequiresModel` booleans. The server validates with
it; clients may hide an unsupported input but still must handle the server's refusal.

### Environment references

- References store names; literal values stay in the private server config. Public descriptors
  contain reference names and literal target names, never literal values. The private resolver
  overlays instance values on inherited server environment without modifying the server process.
  A launch uses the same resolved executable, argv, environment and native config roots that
  model discovery uses.
- A missing source variable fails the launch with `LAUNCH_ENV_MISSING`
  (`{ profileId, name }`); nothing is spawned and no ambient credential is substituted.
- An existing variable whose value is an empty string counts as present.
- `CORRAL_*` and process/loader/config-location names are reserved as `targetName`:
  `TERM`, `PATH`, `SHELL`, `HOME`, `BASH_ENV`, `ENV`, `NODE_OPTIONS`, `NODE_PATH`, `XDG_*`,
  `LD_*`, `DYLD_*`, anything ending in `_HOME`, anything containing `CONFIG`,
  `PI_CODING_AGENT_*` and `PI_PACKAGE_DIR` (pi loader path), except that `CLAUDE_CONFIG_DIR`,
  `CODEX_HOME` and `PI_CODING_AGENT_DIR` are allowed. For those three, resolution expands leading
  `~` against the server home, including referenced values; other values are not expanded. The
  same expansion applies when a saved launch is resumed. A snapshot that somehow holds a reserved
  target fails with `LAUNCH_ENV_RESERVED` instead of applying it.
- Server-owned `CORRAL_SESSION_ID`, `CORRAL_TASK_ID`, `CORRAL_STATUS_URL` and
  `CORRAL_STATUS_TOKEN` are applied after instance values and win.
- An instance's literal values are captured privately at start (see
  [Snapshot and resume](#snapshot-and-resume)); changing or deleting the instance does not change
  the environment of a session that already exists.

At most 32 references per profile. A target may appear once.

## Starting a session

`sessions.start` accepts the existing `{ taskId, kind, size }` plus optional `profileId` and
`model`:

| Input                 | Result                                                                 |
| --------------------- | ---------------------------------------------------------------------- |
| neither               | The unchanged default launch. No snapshot.                             |
| `profileId`           | The profile's agent/model/provider/env.                                |
| `profileId` + `model` | The profile, with `model` overriding its model.                        |
| `model` alone         | A bare native model choice; snapshot has `profile: null`, no env refs. |

`expectedProfileRevision` may accompany `profileId`. Send the `revision` that
`config.watch` showed when the user chose the profile: the server compares it with the same
captured profile it uses for the snapshot, before anything is spawned. A profile that changed in
between is refused with `LAUNCH_PROFILE_CHANGED { id }` and creates no session or process.
Omitting the revision keeps latest-by-id behavior. Supplying it without `profileId` is refused
with `LAUNCH_PROFILE_REVISION_UNSUPPORTED`. A missing or dropped profile is still
`LAUNCH_PROFILE_UNKNOWN { id }`, with or without a revision.

Model override rules:

- `model` must match `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$` (native ids such as
  `claude-sonnet-4-5`, `anthropic/claude-sonnet-4:high`, `gpt-5-codex`).
- claude, codex and pi accept it; opencode and shell refuse it with
  `LAUNCH_MODEL_UNSUPPORTED { kind }`.
- A syntactically invalid value fails with `LAUNCH_MODEL_INVALID { kind }`.
- Unsupported or invalid choices are refused before a spawn, never ignored or replaced by the
  agent's default.
- The provider cannot be overridden per start; it comes from the profile.

Other start/restart errors: `LAUNCH_PROFILE_UNKNOWN { id }` (unknown or dropped profile),
`LAUNCH_PROFILE_CHANGED { id }`, `LAUNCH_PROFILE_REVISION_UNSUPPORTED`,
`LAUNCH_PROFILE_KIND_MISMATCH { id, kind }`, `AGENT_DISABLED { kind }`,
`AGENT_NOT_FOUND { command }`, and `LAUNCH_FAILED { kind, message }` for an unexpected spawn
failure (a missing workspace, resource limits) or a refused instance: disabled for a new launch,
or an argv the runtime does not support. `LAUNCH_FAILED.message` is the first diagnostic line,
prefixed with the OS error code when there is one (for example `E2BIG`). Every non-empty value
referenced by the profile or captured as a literal is replaced with `[redacted]` before the line is
taken, so short and multiline values are covered too. The log gets the full diagnostic, redacted
the same way; a raw error object is never logged.

## Snapshot and resume

Selecting a profile or model snapshots the nonsecret choices on the session:

```ts
{
  kind: "claude",
  profile: { id: "claude-gateway", name: "Claude via gateway", revision: "a1b2c3d4e5f6" },
  model: "claude-sonnet-4-5",
  provider: null,
  env: [{ targetName: "ANTHROPIC_AUTH_TOKEN", fromEnv: "CLAUDE_GATEWAY_TOKEN" }],
}
```

It is persisted in SQLite (`sessions.launch_spec`) and is immutable. Stop/restart, settle/resume
and server-restart restore use the snapshot; editing or deleting the instance does not change an
existing conversation. Referenced values are re-resolved from the server environment on every
launch. Sessions created before this feature have no snapshot and keep their old launch behavior;
Corral never infers a profile or model for them.

Beside that public snapshot the server keeps a private launch spec in
`session_launch_specs`: the instance id, the resolved executable, its argv and any literal
environment values. A restart runs that captured spec, not whatever the same-named instance has
been edited into since. This is also why disabling or deleting an instance blocks only new
launches: an existing session still stops and resumes. Referenced values are not copied into the
private spec; they stay names and are resolved from the server environment again, so a removed
server variable fails visibly instead of quietly using an old secret.

If a restore cannot launch (missing reference, missing executable, reserved snapshot target,
unexpected spawn failure), the session becomes `stopped` and carries `launchError`, a safe
sentence naming the reference or command and never a value; an unexpected spawn failure is
redacted first. It is visible to clients that connect after the server started, and a manual
`sessions.restart` returns the typed error again. `launchError` is not persisted; it is null
after a successful launch.

## Public descriptor and settings

`config.watch` yields `ConfigState`:

```ts
{
  path: "/home/me/.config/corral/config.toml",
  config: { keys: ... },
  profiles: [
    {
      id: "claude-gateway",
      name: "Claude via gateway",
      agent: "claude",
      model: "claude-sonnet-4-5",
      provider: null,
      env: [{ targetName: "ANTHROPIC_AUTH_TOKEN", fromEnv: "CLAUDE_GATEWAY_TOKEN" }],
      revision: "a1b2c3d4e5f6",
    },
  ],
  agents: [
    { kind: "claude", found: true, chatDriver: false },
    { kind: "pi", found: true, chatDriver: true },
    // one entry per AgentKind
  ],
  problems: [{ severity: "error", path: "profiles.broken", message: "..." }],
}
```

`ConfigState.agents` adds one entry per agent: `{ kind, found, chatDriver }` — whether the
effective command is executable on the server host, and whether this build can show the agent as
chat (the same list `chat.capabilities` reports). The command and its `enabled` flag are in
`config.agents[kind]`, with the layer each came from.

The settings surface can therefore show effective profiles, display names, native
model/provider, environment **reference names**, capability hints from
`AGENT_LAUNCH_CAPABILITY` (`@corral/protocol/config`), the agents and their availability, and
configuration problems. It must not ask
for or display resolved values; the server never sends them. To start a session, send `profileId`
and optionally `model`; the server validates them and returns the snapshot.

## Protocol and old daemons

The combined client/server contract is protocol version 14. Version 3 added launch profiles
and their revision pin; version 4 added the settings action; version 5 protects task-source
inputs; version 6 adds the task title source, `tasks.rename`, the rename-task/session-number
actions and the required task, naming and project settings; version 7 adds the sidebar-mode
action, the server-owned task `seenAt` and, while still unreleased, the task's prompt and primary
session; version 8 adds the toggle-sidebar action; version 9 adds the `chat.*` contract, the
session's `view` (optional until B1's migration), `sessions.setView`, the
abort-turn/change-model/change-reasoning/switch-view bindings, `[tasks] view = "chat"`,
`[agents.<kind>]` with `AGENT_DISABLED`, and `ConfigState.agents`; version 10 turns
`chat.capabilities` from a driver list into the per-agent capability record (`kind`, `steer`,
`followUp`, `approvals`, `modelSwitch`, `reasoningLevels`, `terminalView`); version 11 requires
the shared model catalog (`models.watch/save/catalog`) on every client; version 12 adds the
focus-sidebar action and its binding; version 13 requires `projects.directories` before project
registration; version 14 adds the required project base/pin fields, nullable task project/branch/
workspace ownership, the model policy's `providerOrder`/`modelOrder`, and `projects.baseRefs`. A
protocol 4 daemon would
strip task sources, a
protocol 3 daemon sends an exhaustive bindings record without `settings`, and a protocol 2
daemon would strip launch fields and start the agent natively; a protocol 5 daemon strips the
title source and its bindings, a protocol 6 daemon strips `seenAt` and the sidebar-mode binding
and has no `tasks.markSeen`, a protocol 7 daemon strips the toggle-sidebar binding, a
protocol 8 daemon has no `chat.*` procedures, no `sessions.setView` and its sessions carry no
`view`, and a protocol 9 daemon answers `chat.capabilities` with a bare driver list instead of
the capability record, a protocol 10 daemon has no `models.*` contract, and a protocol 11 daemon
strips the focus-sidebar binding. Clients
must therefore refuse older versions: the endpoint check reports a protocol mismatch, and a
WebSocket handshake on an older version closes with `4001` and the server's version before any
route, keymap or session mutation. The old daemon is left running with its sessions; nothing
bypasses the version barrier.

Growing version 10 in place means a **same-version daemon from before a later slice** is accepted
by that barrier and simply has no procedure for the newer calls: it answers oRPC's own `404 No
procedure matched`, which the client reports as an undefined `NOT_FOUND`
(`procedureMissing` in `packages/client/src/rpc-errors.ts`). Every such surface says so instead of
showing a failed write: the Changes tab and the finish bar say the server does not offer the
changes API, commit, push or pull requests, and chat's local links say it does not offer file
links — all with "restart it after upgrading Corral".

## Security

The launch path adds the instance's executable, argv and environment to the agent; the config
parser rejects reserved control targets, model choices are validated per agent, and a missing
reference fails visibly. Literal values are persisted only in the private launch spec so a restart
can reproduce them. It does **not** promise account isolation: the child still inherits the
server's other environment variables and can read the user's own agent credential files, so a
personal and a team instance are not separate accounts. `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and
`PI_CODING_AGENT_DIR` move the roots a launch and the drivers' history reads use; they are not an
account boundary on their own.

The config file is a trusted user file. Protecting the RPC/terminal transport from a hostile web
page is a separate, per-server transport capability (another change), not a property of profiles.

## Not supported

- Pre-launch model/provider discovery or listing. Creation takes a native ID; a running chat's
  model and thinking lists come from its driver. No pre-launch thinking field exists.
- Model or provider changes for an existing terminal conversation. A chat session changes its
  model and reasoning level mid-session through its driver (`chat.setModel`/`chat.setReasoning`);
  a terminal session has no such control.
- OpenCode launch-time model/provider (2.1.4 has no root flags; Corral does not switch to `run`).
- Instance-provisioned flags for Claude, Codex or OpenCode, a shell command line instead of argv,
  `--api-key` on argv, `-p/--profile`, credential managers, or direct-API chat providers.
- A DeepSeek or any other product preset. Providers and models are the user's choice.
