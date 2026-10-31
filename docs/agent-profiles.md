# Agent launch profiles

A launch profile names an agent and, where that agent supports it, a native model/provider and
environment variables for one conversation. Profiles live in the server-owned
`config.toml` (`$CORRAL_CONFIG_DIR/config.toml`, else `$XDG_CONFIG_HOME/corral/config.toml`,
else `~/.config/corral/config.toml`). Editing the file is supported; the server watches it and
pushes safe descriptors to every client.

Profiles are explicit launch choices, **not a sandbox or an account boundary**. The agent still
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
- `env` is an optional array of `{ targetName, fromEnv }`; both are variable names.
  `targetName` is set in the agent's environment, `fromEnv` is read from the server's
  environment. Literal values are not supported.
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
model, provider and environment reference names. It lets a session say which definition it used.

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
Codex itself, at request time.

The same table is exported for clients, so a picker does not duplicate the rules:

```ts
import { AGENT_LAUNCH_CAPABILITY } from "@corral/protocol/config";

AGENT_LAUNCH_CAPABILITY.opencode;
// { model: false, provider: false, providerRequiresModel: false }
```

Each entry has `model`, `provider` and `providerRequiresModel` booleans. The server validates with
it; clients may hide an unsupported input but still must handle the server's refusal.

### Environment references

- Only names are stored, sent to clients, written to SQLite and logged. Values are resolved from
  the server's environment once per launch, immediately before spawn.
- A missing source variable fails the launch with `LAUNCH_ENV_MISSING`
  (`{ profileId, name }`); nothing is spawned and no ambient credential is substituted.
- An existing variable whose value is an empty string counts as present.
- `CORRAL_*` and process/loader/config-location names are reserved as `targetName`:
  `TERM`, `PATH`, `SHELL`, `HOME`, `BASH_ENV`, `ENV`, `NODE_OPTIONS`, `NODE_PATH`, `XDG_*`,
  `LD_*`, `DYLD_*`, anything ending in `_HOME`, anything containing `CONFIG`,
  `PI_CODING_AGENT_*` (pi config, session-store and package paths) and `PI_PACKAGE_DIR` (pi
  loader path). This keeps executable lookup, transcript/rollout discovery and the agent's
  history in the same place as the launch. A snapshot that somehow holds a reserved target fails
  with `LAUNCH_ENV_RESERVED` instead of applying it.
- Server-owned `CORRAL_SESSION_ID`, `CORRAL_TASK_ID`, `CORRAL_STATUS_URL` and
  `CORRAL_STATUS_TOKEN` are applied after profile references and win.
- The same resolved environment is used for the spawn, the executable check, Claude transcript
  discovery, Codex rollout discovery and the OpenCode status plugin. No path reads
  `process.env` behind the resolved launch.

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
`LAUNCH_PROFILE_KIND_MISMATCH { id, kind }`, `AGENT_NOT_FOUND { command }`, and
`LAUNCH_FAILED { kind, message }` for an unexpected spawn failure (a missing workspace,
resource limits). `LAUNCH_FAILED.message` is the first diagnostic line, prefixed with the OS
error code when there is one (for example `E2BIG`). Every non-empty value referenced by the
profile is replaced with `[redacted]` before the line is taken, so short and multiline values
are covered too. The log gets the full diagnostic, redacted the same way; a raw error object is
never logged.

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
and server-restart restore use the snapshot; editing or deleting the profile does not change an
existing conversation. Referenced values are re-resolved from the server environment on every
launch. Sessions created before this feature have no snapshot and keep their old launch behavior;
Corral never infers a profile or model for them.

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
  problems: [{ severity: "error", path: "profiles.broken", message: "..." }],
}
```

The settings surface can therefore show effective profiles, display names, native
model/provider, environment **reference names**, capability hints from
`AGENT_LAUNCH_CAPABILITY` (`@corral/protocol/config`) and configuration problems. It must not ask
for or display resolved values; the server never sends them. To start a session, send `profileId`
and optionally `model`; the server validates them and returns the snapshot.

## Protocol and old daemons

Launch profiles, their revision pin, and the settings action are protocol version 4. A
long-lived protocol 3 daemon sends an exhaustive bindings record without `settings`; a client
would silently run an incomplete keymap. A protocol 2 daemon would also strip the launch
fields and start the agent natively. Clients must therefore refuse both: the endpoint check
reports a protocol mismatch, and a WebSocket handshake on an older version closes with `4001`
and the server's version before any route, keymap or session mutation. The old daemon is left
running with its sessions; nothing bypasses the version barrier.

## Security

Corral promises exactly this: a profile adds the named environment references to the agent, the
server rejects reserved/config-location targets, model choices are validated per agent, and a
missing reference fails visibly. It does **not** promise account isolation: the child still
inherits the server's other environment variables and can read the user's own agent credential
files, so a personal and a team profile are not separate accounts. Isolation would require an
isolated agent home/config, which Corral does not offer; config/home overrides are rejected
precisely because they would move history away from Corral's discovery.

The config file is a trusted user file. Protecting the RPC/terminal transport from a hostile web
page is a separate, per-server transport capability (another change), not a property of profiles.

## Not supported

- Model/provider discovery or listing; Corral takes a native id and does not ask a provider.
- Model or provider changes for an existing conversation. Start a new session instead.
- OpenCode launch-time model/provider (2.1.4 has no root flags; Corral does not switch to `run`).
- Literal environment values, shell snippets, extra arguments, a custom executable, `--api-key`
  on argv, `-p/--profile`, credential managers, or direct-API chat providers.
- A DeepSeek or any other product preset. Providers and models are the user's choice.
