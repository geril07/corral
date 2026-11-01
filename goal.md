# Goal: stages B and C — chat, more drivers, git

Deliver stage B and then stage C of Corral. Stage B: an agent session can be read and driven as chat (pi first) in a tab next to its terminal, with one writer per session, model and reasoning controls, and a handoff that keeps the same agent session. Stage C: the same for OpenCode, Claude Code and Codex as far as each agent allows, plus a Changes tab per task, local links in chat, and commit/push/PR from the task. The plans are the queue; the decisions below are already settled and must not be re-litigated. You are the orchestrator of this run; the user is not available, so you make the calls (see **Decisions and blockers**).

## Read first

1. `AGENTS.md`: commands, commit rules, gotchas.
2. `docs/design.md`: decisions 3, 5, 7, 13–17, **Terminal and chat**, **Stages**. Product truth.
3. `docs/ux.md` **Target flow** and the rules that stay; `docs/layout.md` **Chat**, **Session tabs**, **Changes** for placement and sizes. `layout.md`'s **Review later** list is for the user, do not reopen those choices.
4. `docs/plans/stage-b.md`: the stage B queue (slices, order, briefs, gates). `docs/plans/stage-c.md`: the stage C queue — its briefs are coarse and must be rewritten before C0 (D8).
5. `docs/roadmap.md` (**Working mode**, **Decision boundaries**) and `docs/progress.md` (baseline, test notes, stage A ledger).
6. `docs/plans/stage-a-run.md`: the previous run's contract. Its process, gates and boundaries carry over unless this file changes them.

## Decisions settled before the run

These were researched before the run (2026-11-01) and are part of the contract. Record each in the docs named by D10 in the slice that implements it; do not reopen.

- **D1 — Chat Markdown is Streamdown 2.7.x with `@streamdown/code` (Shiki), not T3 Code's `react-markdown`.** The deciding case is streaming partial Markdown: Streamdown closes incomplete constructs (`remend`) and sanitizes (`rehype-harden`/`rehype-sanitize`) by design, while T3's `ChatMarkdown.tsx` is 1300 lines of T3 environment plumbing (skills, workspace assets, PRs) that this plan already says to rewrite and does not handle partial input. It is Apache-2.0, React 19 peer, and built on shadcn CSS variables, which this app already ships. Port T3's _visual_ conventions and its Shiki setup, not the component. Add the `@source` lines its README requires to `apps/web`'s CSS.
- **D2 — No Tiptap in stage B.** Chat's composer is plain text with the A5 semantics (Enter sends, Shift+Enter newline, IME guard, prefix mode in the capture phase); rich text and attachments are not in stage B. Decision 15 is amended accordingly.
- **D3 — the pi driver is a hand-written JSONL client against the documented RPC protocol**, not pi's exported `RpcClient`: the protocol is short and specified, and a pi npm dependency would pin a pi version apart from the user's installed binary. Frame strictly on LF (never `readline`), correlate responses by `id`, read stdout continuously, treat stderr as diagnostics. Probed against pi 1.4.0: `.e2e/stage-b/probe/README.md`.
- **D4 — verification stance: deterministic fakes for the suites, the real binary for fidelity.** Unit, server and browser tests keep a fake `pi` RPC executable. Driver fidelity and the handoff are additionally proven against the **real pi binary driven by a local stub OpenAI-compatible endpoint** with `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_OFFLINE=1`: zero cost, no network, no writes to `~/.pi`. Proven end to end before the run (RPC resume + `pi -p` continue + RPC resume on one session id); reuse `.e2e/stage-b/probe/{stub-server.mjs,drive.mjs,models.json}`. Extend `apps/server/test/contracts` with this as an opt-in test.
- **D5 — protocol versions.** 9 at B0 (`chat.*`, `Session.view`), 10 at the first stage C slice that changes the contract. Both unreleased: one coherent history entry per bump, the handshake barrier keeps refusing older daemons.
- **D6 — T0 fixes the user-visible half of the A-verify P2 before B.** The multi-client terminal P2 is a client that adopts the shared grid without refitting when it regains focus or visibility. T0 adds that refit (focus/visibility triggers the existing fit path) so the active client always matches the PTY, and documents the remaining limitation: while a client is unfocused its canvas is stale, and two clients still share one grid. The shared-grid redesign (per-client grid or smallest-wins on the server) is not part of this run; record it as an open design question in `docs/design.md` **Terminal**.
- **D7 — Codex's view capability is measured, never assumed.** C3 first probes the app-server plus `codex --remote` TUI (does the TUI accept input while another writer is attached?) and records the answer in `docs/design.md` **Terminal and chat**. Implement the measured capability (`both-live`, `view-only-terminal`, or `handoff-only`) and mark Codex's row in the capability table accordingly. Claiming both-live without the probe is a failed slice.
- **D8 — C starts with a rewriting slice, `C-prep`**: rewrite each brief in `docs/plans/stage-c.md` against the integrated B1 driver and the real code (files, APIs, done-when), as `stage-a.md` is written, commit it as a docs-only branch, then run C0–C6 against the rewritten briefs. Re-scoping a C slice within `design.md`'s decisions is expected; inventing a different stage is not.
- **D9 — stage C verification.** Deterministic fake servers and fake CLIs for the suites; real `--help`/`--version` probes recorded per driver; and, per driver, a real-binary smoke against a local stub endpoint where the CLI allows an endpoint override (`claude` via `ANTHROPIC_BASE_URL`, `codex` via `-c model_provider=…`/`--local-provider`, OpenCode via its provider config and `opencode serve`). No real host writes: C6 verification uses a local bare repository and fake `gh`/`glab`, as the plan says. Installed versions recorded on 2026-11-01: claude 2.1.316, codex 0.166.0, opencode 2.2.5, pi 1.4.0, gh 2.102.1, glab 1.126.0.
- **D10 — where a decision is recorded.** Product/UX/technical decisions this run makes go to `docs/progress.md` **Decided for review** (question, options, choice, why, code path) and, when they change the product or an engineering rule, into `docs/design.md` or `docs/engineering.md` in the same slice. Decisions already settled above are recorded the same way but need no re-derivation.

## Waves and gates

```
stage B:  T0 → B0 → (B1, B3) → (B4, B5) → B-verify → B docs
stage C:  C-prep → C0 → (C1, C4, C5) → (C2, C6) → C3 → C-verify → C docs
```

- Gates for every slice are `docs/plans/stage-a.md` → **Gates for every slice**: `mise exec -- pnpm check`, plus `pnpm test:browser` for web slices and `pnpm test:e2e` for user-visible flows, with logs under `.e2e/stage-b/<slice>/gates/` or `.e2e/stage-c/<slice>/gates/`. A claim without a log is not done.
- `pnpm test:browser` and `pnpm test:e2e` run one at a time across all worktrees through `flock /tmp/corral-heavy-tests.lock`.
- At most three workers at once. Slices of one wave may run in parallel; integrate one at a time, rebasing onto the result. Migrations and `rpc.ts` merge conflicts are renumbered by you during integration.
- Stage B ends when **B done when** holds; then stage C starts on the result. Do not start C work inside a B branch.

## How to run

- Orchestrate; delegate exploration, implementation, review and verification to the matching agent roles, with the model named in `docs/roadmap.md` → **Working mode** (`opencode-go/deepseek-v4.1-flash:high`). No model fallback: if that model works unreliably or throws errors, retry the same agent up to three times, then move to the next slice or stop the run when nothing remains, recording the failure.
- One slice per branch (`feature/stage-b-<slice>`, `feature/stage-c-<slice>`) in its own worktree under `/home/geril/code/my/corral.worktrees/`.
- A slice is integrated when its gates pass, its review has no open P0–P2 finding, and it is rebased onto `main` and fast-forwarded.
- After each integration, update `docs/progress.md` (ledger row: outcome, commit, gate counts, evidence path); keep evidence under `.e2e/stage-b/<slice>/` or `.e2e/stage-c/<slice>/`.
- When a brief turns out wrong against the code, decide within `design.md`'s decisions, correct the brief in its plan in the same branch, and say why in the slice report.
- You write no feature code yourself beyond conflict resolution and one-line fixes; anything larger goes back to a worker.

## Subagent workflow

Per slice, as in `docs/plans/stage-a-run.md` → **Subagent workflow**, with these paths and review rules:

1. **Prepare** (you): branch and worktree from `main`, `mise exec -- pnpm install`, brief at `.e2e/stage-b/<slice>/brief.md` (the plan's section verbatim, worktree path, decisions by name, gates, report format).
2. **Explore** (optional): only when file references look stale.
3. **Implement** (worker, cwd = worktree): gates, commits, `.e2e/stage-b/<slice>/report.md`.
4. **Check** (you): read report and diff, rerun `pnpm check`.
5. **Review** (reviewer): **mandatory** for T0, B0, B1, B4, B5 and for every C slice (protocol, process launch, storage, config, file paths, remote writes); B3 by risk. Findings P0–P3 into `review.md`.
6. **Fix loop**: P0–P2 back to the same worker; re-review the fix; P3s fixed or recorded.
7. **Integrate**: rebase, rerun gates, fast-forward, ledger row.

Stage verification uses an e2e-verifier that wrote none of the code, given the stage's verify section, how to build and start the app, and the boundaries below. It also takes the real-binary probes of D4/D9 as evidence, not the repo's own suites.

## Boundaries

- Local only: there is no git remote; push nothing, publish nothing, and never write to a real remote, PR host or agent account.
- No paid model calls, no paid dependency, no new account. Free dependencies only, recorded in `docs/engineering.md` when added.
- Never write to the user's global agent config (`~/.claude`, `~/.codex`, `~/.pi`, OpenCode's config) or to `~/.config/corral/config.toml`; tests and probes use isolated directories, including `PI_CODING_AGENT_DIR`/`PI_CODING_AGENT_SESSION_DIR`.
- Leave existing branches and worktrees from earlier runs untouched.
- Out of scope: everything under **Not in stage B** and **Not in stage C** in the plans (mobile, remote servers, orchestration, transcript storage, images in the composer); appearance changes beyond what `layout.md` asks of a slice. The roadmap's "when the queue runs out" rule does not apply: the run ends when stage C is done.

## Decisions and blockers

- **Product or UX question** not settled by `design.md`, `ux.md` or `layout.md`: decide it yourself, choosing the option that fits those docs and is easiest to reverse, implement it, and record it under **Decided for review** (D10). These are not blockers.
- **Something that would cost money, need an account, or write outside this machine**: do not do it; take the free local alternative (fake, stub endpoint, deferred hook), record it under **Decided for review**, and continue. An agent whose real CLI needs a subscription login is verified through its stub endpoint or its fake, and the gap is recorded.
- **Technical failure** (a failing gate, a broken tool, a brief that contradicts the code): find the cause and fix it. Do not raise timeouts or retry into green without evidence. If one approach is a dead end, try another; correct the brief and say why.
- **A slice whose premise is false** (D7's probe contradicts the docs, C2's SDK does not use the user's login, an experimental protocol does not hold): implement the closest thing the code supports, document the measured reality, and continue — unless the stage's own done-when cannot be met, in which case record the evidence and say what remains.
- The only reason to end before **Done when**: an obstacle no agent action can remove (e.g. the machine lacks a required tool and cannot install it). Record the evidence in `docs/progress.md` and report what remains.

## Done when

Stage B:

- T0 and B0–B5 are integrated on `main`, each with its ledger row in `docs/progress.md`; the B plan and briefs are corrected where the code disagreed.
- On the final stage B tree, `pnpm check`, `pnpm test:browser` and `pnpm test:e2e` pass under the pinned Node; counts and logs recorded.
- B-verify is PASS by an independent verifier: report at `.e2e/stage-b/verify/report.md` with screenshots at 1920×1080 and 1024×640, layout measured against `layout.md` **Chat**, and evidence from the real-pi probe (D4) that chat → terminal → chat resumes one real pi session without a second writer.
- `docs/ux.md` describes chat as current for pi (target flow), `docs/design.md` decision 15 carries D1/D2 and **Terminal and chat** carries the chat contract, `docs/roadmap.md` marks stage B done.

Stage C:

- `C-prep`'s rewritten briefs are committed; C0–C6 are integrated on `main`, each with its ledger row.
- On the final stage C tree, the same three gates pass; counts and logs recorded.
- C-verify is PASS by an independent verifier: report at `.e2e/stage-c/verify/report.md`, with per-driver evidence (OpenCode both views live or the measured alternative, Claude Code and pi handoff, Codex per D7), the Changes tab, links, and commit/PR against a local bare repo and fake `gh`/`glab`; screenshots at both viewports.
- `docs/design.md` records each driver's measured capability, `docs/roadmap.md` marks stage C done, `docs/progress.md` has both stages' ledgers, every **Decided for review** entry, and a **Verified only with fakes** section for each stage.

The final report to the user lists what changed for them stage by stage, every **Decided for review** entry, anything verified only with fakes or stubs, and what remains open (for example the shared-grid terminal design question from D6).
