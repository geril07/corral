# Integration research: issue import and titles

Durable memo for issue import (GitHub/GitLab), PR/MR status and title generation. It records decisions, not implementation steps; the newer research result overrides earlier claims below. Verified 2026-10-30 against installed `gh` 2.102.1 and `glab` 1.124.0 (`--help`) plus the public docs cited.

## Decisions

- Import is read-only: issue title, body, URL and link-out become task fields; no writes back to the host, no state mirroring, and no bidirectional sync (it needs write scopes and conflict rules nothing in the MVP uses).
- CLI first: run the user's authenticated `gh` / `glab` and parse their JSON. Tokens stay in the CLI's keyring/config; Corral never reads `gh auth token`, never puts a token in the server, protocol, SQLite or argv.
- Authenticated-only: credentials come from the user's authenticated CLI, never from Corral. A missing binary, failed sign-in, timeout or network failure stays visible and actionable (sign in, install, retry) and never reports a successful import; the manual fallback is to paste the URL or keep the typed title, and manual task creation is never blocked.
- Host trust comes before any CLI spawn: `github.com` / `*.ghe.com` and `gitlab.com` are public; any other host is accepted only when the project's git remotes or the server's own `GH_HOST` (GitHub) / `GITLAB_HOST`, `GITLAB_URI`, `GL_HOST` (GitLab) name the same exact host and port. The provider dropdown alone never authorizes a host. Tokens and hosts are not duplicated in Corral, and Corral does not call auth commands that would contact an unverified host. A self-hosted host with no matching remote or operator variable gets `ISSUE_HOST_UNTRUSTED`, with manual task creation still available.
- Ports: `gh` 2.102 parses an issue URL's hostname without its port and ignores the URL in favor of `--repo`, so GitHub issue URLs on a nonstandard port are rejected with `ISSUE_UNSUPPORTED_PORT` rather than fetched from the wrong endpoint. GitLab keeps the exact host and port in its URL; its trust check compares that exact `host:port`.
- Credential binding: a project git remote proves the host belongs to that project, not that the operator's global `GH_ENTERPRISE_TOKEN` / `GITHUB_ENTERPRISE_TOKEN` belongs to that vendor. For a custom GitHub host trusted only by a remote, Corral strips those two variables from the child and lets the native CLI's host-scoped login apply; `GH_HOST` naming that exact host preserves them. Other trusted hosts without a binding fail with `ISSUE_HOST_UNTRUSTED`, and the UI offers manual task creation. GitLab trust variables and GitHub trust variables are never interchangeable.
- Identity: GitHub owner/repository comparison is case-insensitive while the task keeps the spelling from the pasted canonical URL. GitLab paths stay exact until its native case rules are verified. Windows drive paths, UNC paths and `file:` URLs are local paths, never remotes, and cannot authorize a host.
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
