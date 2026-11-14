# UI rebuild — status and open decisions

The rebuild was merged in #264. This file records remaining decisions and limitations, not an
authorization to start another slice. Product decisions are in `design.md`, current placement in
`layout.md`, and the rebuild review process in `delivery.md`. Git history and
the issues own completed slice plans and review records.

The visual direction remains T3 for structure and behavior, OpenCode for visual language, with one
implementation per shared pattern and no invented user-visible copy. See `delivery.md` and
`ui-kit.md` for the rules and provenance.

Settle is T3-style since #277: it shelves a task and never stops its sessions; new work in a
settled task makes it active. `design.md` owns the decision.

## Open decisions

- Model favorites across instances need a display-name and cross-instance application rule.
- Real attachments and pre-launch reasoning need separate contract decisions. Both controls are
  disabled today; reasoning levels currently come from a running chat.
- Title-only task creation remains supported by the server but not exposed by the routed composer,
  which requires a prompt. Whether to expose a title control remains open.
- Chat-start polish, including focus intent, a device-local last-used model, headline and create
  gating wording, is not authorized by this cleanup.
- The chat picker keeps the new-launch Chat/Terminal choice in a fixed footer; whether that control
  belongs in the picker or another surface is open (#275 review).
- Settings → Models no longer receives the picker's task/project context; whether routed Settings
  should know the active project is open (#275 review).
- A view switch in a settled `handoff-only` session stops the live frontend and starts the other
  while the task stays shelved; whether a live handoff should un-shelve is open (#277 review).
- Starting in a settled task activates it before validation; whether a pure refusal (disabled
  agent, changed profile) should leave it shelved is open (#277 review).
- The following Corral-only strings remain unresolved: the four settings section descriptions
  (`settings-sections.ts`), the model-ordering paragraph (`model-management.tsx`), the task prompt
  placeholder and disabled attach/reasoning hints (`task-composer.tsx`), and the tab labels
  `Companion tabs`, `Resize companion group` and refusal lines for closing or moving the primary
  tab and moving the only main tab. Reference wording for the placeholder exists;
  the disabled hints have no reference wording.

## Known limitations

- Issue #265 ported the live old-interface coverage to the routed shell and removed the unmounted
  old screens and the `/board` route. Links, session lifecycle, handoff, keymap,
  status and connection recovery run against the routed shell. Electron helpers and specs are
  migrated; no old or partial run is a green release gate.
- The routed shell's Search is the sidebar row and `prefix f`: a command palette over the tasks the
  client already watches, with the `No project` badge on a scratch task. Enter opens an active task
  or a settled one; opening a settled task neither restarts it nor un-shelves it, and starting work
  in it is what makes it active (#277, #274).
- The connection status left the sidebar after #269. The footer keeps its actions, the config
  problem opener and the prefix hint; the connection is a banner above the working area in both
  sidebar states, following T3's unavailable-environment banner rather than a header word. A
  reconnect shows after a **2 s** grace; a refused capability, invalid capability or protocol
  mismatch shows at once. `Retry now` appears where a retry can help and `Details` opens the
  recovery dialog. The hidden-sidebar strip still owns a row only for a persistent failure or
  config problem, and the armed prefix floats without shifting the workspace.
- **Editor terminal visibility (live blocker).** Opening a local file in chat calls
  `files.openEditor`, which starts the configured editor as a loose terminal in the task's
  workspace. The routed shell has no loose-terminal view, so the chat lane stays visible and the
  editor's output is unreachable. Repro: configure `[editor] command = "/bin/cat {file}"`, open a
  chat with a workspace path such as `src/app.ts:3`, and click the path button; the terminal is
  created (`terminals.list` shows it with the resolved path and `taskId: null`) but the transcript
  does not give way to it. The same failure is the last assertion in `apps/desktop/e2e/links.spec.ts`.
  Desired future behavior: the opened editor terminal appears in the working area (or another
  explicit loose-terminal surface) and takes the keyboard, or the editor opens without a Corral
  terminal. Both assertions stay failing until that product decision; #265 does not weaken them.
- The open Settled shelf mounts every settled row in one scroller; a very long history has a
  corresponding rendering cost. `Project settings…`, project removal and loose-terminal controls
  have no routed-shell entry point. The composer offers `Current checkout` and a new worktree only;
  creating a task on an existing branch remains server-supported with no routed control.
- The 10,000-item chat transcript timing case runs in its own single-process suite because shard
  load made its p95 budget unrepresentative: `pnpm test:perf`. The normal browser gate keeps the
  500/2,000/5,000-item cases and excludes `*.perf.browser.test.tsx`; the 10,000-item assertion and
  its budget are unchanged.
- The composer does not support real attachments or pre-launch reasoning. A scratch task has no Git
  controls; mobile remains out of scope.
- The transcript keeps all turn folds open while the session is working because the protocol does
  not reliably distinguish delivered steers from new prompts. Timestamps and forks need protocol
  work. Earlier copy-action mounting and 5,000-item timing failures limit confidence despite later
  passing runs.
