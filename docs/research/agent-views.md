# Agent research: launch profiles and conversation views

Durable memo for launch profiles and for what a "chat" view of an agent session may promise. Decisions only; the newer research result overrides earlier claims. Implementation reference for profiles: `agent-profiles.md` (separate worker); this memo does not restate the schema. Verified 2026-10-30 against installed CLIs, no user config written.

## Installed-version context

| Agent       | Installed | Model/provider launch                                                       | Conversation view                                                          |
| ----------- | --------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Claude Code | 2.1.310   | `--model`, `--fallback-model`; provider via `ANTHROPIC_BASE_URL`/token env  | Agent SDK `resume` + `getSessionMessages`; no live attach to the TUI       |
| Codex       | 0.164.0   | `-m`, `-c model_provider=…`; `-p` layers `$CODEX_HOME/<name>.config.toml`   | `thread/read` through `codex app-server`; `--remote` gives both views      |
| pi          | 1.4.0     | `--provider` + `--model provider/id`                                        | `--mode rpc` events + `get_messages`; no approval prompts by design        |
| OpenCode    | 2.1.4     | `run -m provider/model#variant`, `--server`, `--session`; no root `--model` | HTTP `GET /session/:id/message`; latest docs show `attach`, 2.1.4 does not |

## Decisions

- A launch profile is agent + optional provider/model + environment references. Env entries are references (`fromEnv`), never literal values, so a file the server watches and broadcasts cannot carry a secret. A missing reference fails visibly and does not fall back to ambient credentials.
- Provider and model are immutable for an existing session; a different profile means a new session (or a future fork). Store agent, provider, model, nonsecret fields and reference names; re-resolve at launch, never store resolved secrets. Old sessions stay `unknown` rather than being inferred.
- Reserved names are rejected in profiles and filtered again at spawn (`CORRAL_*`, `PATH`, `SHELL`, `HOME`, `XDG_*`, `NODE_OPTIONS`, `LD_*`, `BASH_ENV`, `*_CONFIG*`). Adapters validate model/provider pairs per agent kind.
- OpenCode launches env-only until a verified model path exists. Codex uses `-m`/`-c`, not `-p`, because `-p` writes or layers the user's own config file. No direct credential APIs, no credential store in Corral, no secrets in SQLite, protocol or argv.
- Resolve a profile's environment once and use that same resolved object for conversation discovery and resume, not `process.env`; otherwise a profile that changes `CODEX_HOME` or `CLAUDE_CONFIG_DIR` looks in the wrong place and orphans the conversation.
- Profile validation is all-or-nothing: one invalid field disables the profile instead of launching on an account default the UI did not show.
- Security boundary first: a per-server capability token gates the WebSocket upgrade for `/rpc` and terminal streams before any profile integration. The trusted `terminals.create` command API stays as is. Code already running as the same OS user is trusted, like the config and endpoint files; Corral claims no account isolation, because agents also read their own credential stores.
- Chat preserves the agent's native conversation: one writer per agent session, resume by the agent's own id, no generic OpenAI-compatible third history (it has no tools, approvals or session id). Full interactive chat needs a verified writer lease plus approval lifecycle per agent, so it stays a design until that is proven. A read-only history experiment remains a candidate — Claude `getSessionMessages` and pi's documented session format are the safely isolated cases — and is not called chat.

## Known gaps

- Codex `-c` provider definitions are parser-verified but not request-verified; an unknown `model_provider` must fail visibly or default, and that needs a contract test.
- Codex and OpenCode live history need their servers started, adding process, port, health and ownership lifecycle; Claude and pi are read-only files.
- Claude has no supported live attach between SDK and TUI; switching views stops one frontend and resumes the same id.
- pi streams tool events over RPC but does not approve them; a chat view can display tools, not approve them.
- Ambient credentials remain possible in a profiled launch because the child inherits `process.env` and agents read their own stores. The guarantee is only: Corral adds exactly the named references and fails on a missing one.

## Sources

- https://code.claude.com/docs/en/agent-sdk/configuration, https://code.claude.com/docs/en/agent-sdk/sessions, https://code.claude.com/docs/en/cli-reference, https://code.claude.com/docs/en/env-vars
- https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs, https://learn.chatgpt.com/docs/app-server.md, https://learn.chatgpt.com/docs/config-file/config-advanced.md, https://learn.chatgpt.com/docs/config-file/config-reference.md
- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md, `security.md` and `session-format.md` in the same folder
- https://opencode.ai/docs/server/, https://opencode.ai/docs/cli/, https://opencode.ai/docs/config/
- Prior art for env flags and redaction: `.refs/t3code/packages/contracts/src/providerInstance.ts:30-34`, `packages/provider-core/src/server/instanceEnvironment.ts:7-19`, `packages/provider-core/src/server/failure.ts:192`.
