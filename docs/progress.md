# Execution ledger

Scope and operating rules: [roadmap.md](roadmap.md). This records outcomes and evidence, not a second backlog.

## Current baseline

- Integrated `main`: `2a994cb` (existing workspace, UI layering and sidebar correction).
- Pending feature: `mvp5/web`, fixed at `680ff2e` (config-driven keys, palette, config problems); independent retest pending.
- Parent's earlier checks on that feature: 385 Node, 92 browser and 13 Electron tests passed. These do not replace independent E2E verification.
- UX rules: `docs/ux.md` on `roadmap/ux` (`c246245`, `018a4d6`), docs-only; integration pending.

### Test baseline (observed)

- Runtime matters: `mise.toml` pins Node 26.13.0. A shell whose PATH resolves Node 22.23.4 fails four client reconnect tests (`projects/tasks/terminals-store`, `terminal-stream`) deterministically, alone and in the full suite, on both `roadmap/ux` and untouched `2a994cb`; the same files pass alone under 26.13.0. Correct invocation: `mise exec node@26.13.0 -- pnpm …`.
- Under Node 26 the Node suite passed 379/379 twice. A third full run scored 376/379: three `apps/server/src/terminals/*` tests timed out at 5000ms while host load average was ~14.9 on 16 cores, and those files pass isolated.
- Hypothesis, not established: the under-load timeouts are host contention on PTY/timing tests. This is a real follow-on reliability finding; later green runs do not close it.

## Requirement ledger

| Requirement                                                 | Status                                                                 | Authoritative outcome / evidence                                                                                                                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Finish MVP5 web and integrate                               | Fixed at `680ff2e`; independent retest pending                         | Worktree `.e2e/mvp5-client/report.md` and `verify/30-*`, `32-*`; original failure retained                                                                                                             |
| UX rules from T3 Code / Orca                                | Docs complete on `roadmap/ux`; integration pending                     | `docs/ux.md` (`c246245`, `018a4d6`): manager decisions applied, 111 lines                                                                                                                              |
| Apply compact graphical UI; improve workspace/project flows | Inventory complete; implementation pending                             | Implement against `docs/ux.md`; verification pending                                                                                                                                                   |
| Search task history and continue settled work               | Search and rename UI active (`task-search`)                            | Existing all-task watch suffices; no server search API; inspecting a settled task mutates nothing, and an explicit Continue runs the existing lifecycle                                                |
| Persistent session/terminal labels                          | `persistent-labels` implementing protocol/server foundation            | Session labels must survive server restart; loose terminals intentionally exist only for their server lifetime, so their labels survive client/app restarts only                                       |
| GitHub/GitLab issue-to-task with source context             | Issue-import backend active                                            | CLI-first read-only import; preserve title/body/URL; no token extraction; decisions in [research/integrations.md](research/integrations.md)                                                            |
| Issue titles and prompt-derived title research              | Decided; implementation with issue import                              | Issue title used directly; prompt-derived title opt-in through an existing configured mechanism with a deterministic fallback; Deepseek restriction is our staffing, not product providers             |
| Supported profiles/models/environment and configuration UI  | Launch-profiles backend active                                         | Env refs only, model/provider immutable per session, OpenCode env-only, file-owned config, no direct credential APIs; decisions in [research/agent-views.md](research/agent-views.md)                  |
| Chat/terminal relationship                                  | Design only; no interactive chat promised                              | Native conversation preserved; no generic OpenAI-compatible third history; full chat needs a verified per-agent writer and approval lifecycle; a read-only history experiment is a candidate, not chat |
| Close hostile-web-page RPC and terminal-stream access       | Transport capability-auth worker closing it before profile integration | Capability gate on the WS upgrade; the trusted `terminals.create` command API stays; same-user OS code is trusted, with no account-isolation claim                                                     |
| Follow-on product improvement                               | After core slices                                                      | Real-scenario audit, prioritized concrete findings, fixes and verification pending                                                                                                                     |

## Integration gates

- Delegate implementation, research, exploration, risk-based review and E2E; all agents use Deepseek.
- Conventional Commits and linear history. Integrate verified branches by fast-forward after rebase when needed.
- Record exact checks and independent user-interface evidence for each slice.
- Keep externally visible mutations, credentials and real paid agent calls out of tests.
- Resolve a blocked slice separately and continue the remaining queue; record the specific decision needed.

## Active handoffs

Detailed reports are saved in their named agent's `result-N.md`; promote durable findings into repo docs when they arrive.

Durable research: [research/integrations.md](research/integrations.md) (issue import, PR/MR status, titles) and [research/agent-views.md](research/agent-views.md) (launch profiles, conversation views). Launch-profile implementation reference: `agent-profiles.md`, owned by the backend worker.
Do not mark a requirement complete from an agent's assertion alone: inspect the corresponding branch state and evidence artifacts.
