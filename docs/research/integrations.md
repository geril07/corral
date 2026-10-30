# Integration research: issue import and titles

Durable memo for issue import (GitHub/GitLab), PR/MR status and title generation. It records decisions, not implementation steps; the newer research result overrides earlier claims below. Verified 2026-10-30 against installed `gh` 2.102.1 and `glab` 1.124.0 (`--help`) plus the public docs cited.

## Decisions

- Import is read-only: issue title, body, URL and link-out become task fields; no writes back to the host, no state mirroring, and no bidirectional sync (it needs write scopes and conflict rules nothing in the MVP uses).
- CLI first: run the user's authenticated `gh` / `glab` and parse their JSON. Tokens stay in the CLI's keyring/config; Corral never reads `gh auth token`, never puts a token in the server, protocol, SQLite or argv.
- Authenticated-only: credentials come from the user's authenticated CLI, never from Corral. A missing binary, failed sign-in, timeout or network failure stays visible and actionable (sign in, install, retry) and never reports a successful import; the manual fallback is to paste the URL or keep the typed title, and manual task creation is never blocked.
- Host: resolve from the project's git remote, else the CLI's own host settings (`GH_HOST`, `GITLAB_HOST`), with explicit `-R` / `--hostname` when the project path is not a repository root. Self-hosted instances are whatever the CLI is logged into; tokens and hosts are not duplicated in Corral.
- Candidate and deferred, not in the current slice: a read-only PR/MR badge by task branch (`gh pr list --head`, `glab mr list --source-branch`), on demand. The current slice is read-only issue import only, and auto-settling on merge stays out.
- Titles: use the issue title directly on import. Prompt-derived titles are opt-in, use an existing configured agent CLI (never a new provider dependency), run on an untitled draft only, never overwrite typed text, and fall back deterministically (first line of the request, truncated). A timeout or missing CLI yields the fallback.
- The Deepseek staffing restriction applies to our agents, not to product providers; title generation uses whatever agent the user configured.

## Evidence

- `gh issue view <n|url> --json number,title,body,url,state,labels` and `gh pr list --head <branch>`: https://cli.github.com/manual/gh_issue_view, local `gh help`. Auth, keyring and plaintext fallback: https://cli.github.com/manual/gh_auth_login; exit code 4 means auth required (`gh help exit-codes`).
- REST is a fallback only: 60 anonymous vs 5000 authenticated requests/hour and a version header (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api, https://docs.github.com/en/rest/issues/issues). Direct REST would add token plumbing for no capability needed now.
- `glab issue view <id|url> -F json`, `glab mr view -F json`, `glab mr list --source-branch`, `glab api --paginate`: https://docs.gitlab.com/cli/ and https://docs.gitlab.com/cli/configuration/; issue endpoint and private/confidential auth: https://github.com/gitlabhq/gitlabhq/blob/master/doc/api/issues.md.
- Structured title output exists in each configured agent CLI: `claude -p --output-format json --json-schema` (https://code.claude.com/docs/en/cli-reference), `pi --print --mode json` (https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/json.md), `codex exec --output-schema` and `opencode run --format json` (local `--help`). Deepseek's Anthropic-compatible endpoint is one example provider, not a requirement: https://api-docs.deepseek.com/guides/anthropic_api.
- The branch slug from the title already exists (`apps/server/src/git/names.ts:3`, called from `apps/server/src/tasks/worktree-plan.ts`); import reuses it.

## Open

- `glab` anonymous mode: the earlier "no anonymous mode" claim was inferred, not documented. Authenticated-only is the current CLI-first design policy, not a proven capability statement about `glab`; the rule holds while the capability question stays open.
- GitHub Enterprise auto-targeting from a remote without a prior `--hostname` login is unverified, as is the nested shape of `gh auth status --json hosts`.
- Title-generation latency and cost are unmeasured; the PR/MR badge is deferred, not part of this slice.
