# UI rebuild — goal, slices, status

The working plan for the interface rebuild that replaced the first frontend. Use it as the scope:
what the app should feel like, which slices exist, what is done, and what is still open. Update the
status section when a slice lands; a slice that only lives in a chat does not exist.

Rules for how work is done and reviewed: `docs/delivery.md`. Product decisions: `docs/design.md`.

**Where we are (2026-11-11).** All landed slices are on `feat/263-task-composer-instances`, the
branch's current head; nothing is pushed, there is no PR yet, and the running app is the dev
stand built from that branch. One slice is in flight in its own worktree, branch
`feat/263-tabs`. Research for the queued slices is in `.review/research/`
(`tabs.md`, `sidebar-task-menu.md`, `chat-transcript.md`, `chat-start.md`, `drafts.md`); each claim
there carries `path:line` into the reference checkouts.

## The goal

A keyboard-first workspace for running coding agents, rebuilt on two references instead of taste.

- **T3 gives structure and behaviour**: composer geometry, settings shell, tab metrics, instance and
  environment handling, sidebar semantics.
- **OpenCode gives the visual language**: palette and semantic roles, control skin, spacing, quiet
  surfaces, one shared picker frame.
- **Nothing invented.** No user-visible copy, empty state, hint or control that a reference does
  not have. A state that needs wording gets a reference quote or a question to the owner.
- **One pattern, one implementation.** One project picker, one model picker, one composer surface,
  one scrollbar, one row recipe. No per-module control skins.
- **Text is content.** The caret is the focus indicator on fields; no focus rings on text inputs,
  no press transforms, no decorative motion beyond what the references use.

End state: a person opens the workspace, picks a project or a scratch space, writes a prompt, gets a
working agent session in a tab, can run a shell beside it, review the changes, and configure all of
it — without meeting a single invented screen.

## Slices

### Landed

- **Shell and sidebar** (#259, #261) — app frame, task list, status, empty states.
- **Compact Add project** (#260, #262).
- **Task entry, scratch workspaces, agent instances** (#263) — three creation commands, server-owned
  scratch directories, named instances with argv/environment/model preferences, no paid turn on a
  draft.
- **Task composer** (#263) — prompt surface, attach/reasoning slots (honest disabled states), agent
  and model control, one context row: project / workspace / branch, reusing the shared project
  picker, `from <branch>` picker in worktree mode.
- **Model picker** (#263) — three regions: instance rail, searchable virtualized list, thinking
  column; one footer; no "Agent default" row; current-model row when filtered out.
- **Pinned projects and the searchable project picker** (#263) — server-owned `pinnedAt`, pin action
  in the picker, one-row empty states.
- **Settings rebuild** (#263) — T3 geometry (80×60 rem, 240 rail, 720 page), no header row,
  borderless `Search`, T3 row metrics, no click focus boxes, T3 slider with percent and reset,
  select-row for tab position. The dialog is one scroller: the content column owns the wheel, uses
  the kit bar inset from the rounded edge, and the Models page fills the column instead of the
  window.
- **Kit cleanup** — standardized input and prompt padding (16 inline for the prompt, 12 for fields),
  press translate removed from every button, `No project` icon matches the picker.
- **Review fixes on the merged surface** (#263, `d3b8f5b`) — focus after the first project choice,
  a visible and revealed keyboard selection in Settings search, Settings typography that follows the
  interface scale, model reset for a non-default instance, one scrollbar recipe, shared tooltips on
  the instance rail, and a select popup at its trigger's width.
- **Tabs and working area** (#263, `0150b3b`) — two groups per task, primary agent first, Chat and
  Terminal as one tab, Changes in the companion group, close ≠ delete with a closed stack,
  device-local layout, a compact task row above the strip and an actionable empty pane. Mounts the
  real chat, terminal and changes panes.
- **Draft tasks** (#263, `8263d43`) — a draft is a tab in the main group, device-local, one per
  project and reused, with the prompt and the composer's choices surviving Escape and reload.
  Closing the tab discards it with T3's `Discarded`/`Undo`, a project switch never drops a draft
  that has text, an idle window writes nothing, and a successful create clears only the draft that
  sent it.
- **Settings control recipes** (#263, `e13a482`) — the module no longer restyles kit controls: the
  recipes are `Button layout="category"|"result"|"picker-row"` and `Input frame="bare"`, laid out by
  `settings.css` only. The UI gate now rejects a module stylesheet that selects on the kit's
  `data-slot`, so the violation cannot come back unnoticed.
- **Draft ownership, list keys and rail focus** (#263, `262d1b4`) — a create clears and selects only
  the draft that sent it, favorite headings no longer repeat virtual-list keys across providers, and
  the instance rail moves DOM focus with the selection.
- **Dialog and Escape fixes** (#263, `b33f16a`) — dialogs animate without transitioning their
  geometry (the interface scale was animating width, height, font size and radii mid-interaction),
  and Escape with a workspace or branch picker open closes the picker instead of cancelling the
  draft.
- **Technical fixes** (#263, `88444cd`) — protocol 14, `projects.baseRefs` with grouped local/remote
  refs and the main tree's `currentBranch`, disabled instances refused, one owner for saved
  preferences, a missing project cannot be submitted, the checkout row shows the real branch, the
  truncation notice no longer instructs the impossible, and visibility actions keep saved ordering.
- **Task context menu** (#263, merged `0490416`) — Copy ▸ path / branch / task ID, rename, issue
  source only when present, remove. Settle stays out until the shelf exists. Pinning lives in the
  project picker; the shell has no project row to hang a menu on.

### In progress

- **Chat transcript** (`feat/263-chat-transcript`, `92b4c17`) — turn folding that keeps only the
  turn's last message, verb summaries, working/thinking rows, copy on hover and focus, quote from a
  selection, and per-session folds and reading position. Timestamps and forks stay out; they need
  protocol work. UI/UX review done and its findings fixed; technical review in progress.
- **Settled shelf** (`feat/263-settled-shelf`, `c632d16`) — a collapsed `Settled (N)` group at the
  end of the same list, Settle/Unsettle back in the row menu and on the card, and a settled task
  stays selectable with its tabs. Both reviews done and merged.

### Queued, research done

Each queued slice has a report in `.review/research/` with the reference paths, the current Corral
behaviour and the open questions; the slice brief is written from it.

- **Favorites across instances** — the model-picker rail needs a favorite entry that carries a
  display name, and a rule for applying a favorite from another instance. Blocked on that decision.
- **Chat start polish** — one focus intent, a device-local last-used model layer, the hero headline,
  and the create gating wording.

### Deferred or descoped — needs an explicit record

- **Real file attachments** — the composer shows an honest disabled control; a real attachment
  contract (server, driver capability, limits) is its own slice.
- **Pre-launch reasoning** — the protocol reports thinking levels only for a running chat; the
  composer dropdown stays disabled until the driver declares levels up front.
- **Settings → Models page** — the model picker is rebuilt; the settings page is the owner's own
  next slice.
- **Title-only task creation** — the composer requires a prompt today; either add the title control
  or state the limit in the docs.
- **Mobile clients** — later, and not part of this rebuild.

## Known debt

- **The browser suite is mostly red, and the number is bigger than this document used to say.**
  Measured on `197be6f`: 26 of 47 files pass, **21 files and 245 of 662 tests fail**. The failures
  are the legacy surfaces the rebuild replaced (old workspace screens, prefix bindings that no longer
  exist in the routed shell, helpers that still drive the previous UI); the rebuild's own suites —
  composer, settings, pickers, tabs, workspace, chat, terminal — pass. Every slice therefore verifies
  with focused suites, and the full suite is not evidence of anything until this is resolved.
- **`Project settings…`** lives only in the old sidebar and is unreachable until the new shell has
  project rows.
- **Legacy sweep flow** — `.review/orchestrator.md`, `.review/contract.md`, `.review/goal.md`, the
  `.e2e/` artifacts and the `e2e-verifier` role are not used by this pipeline; remove them once the
  new loop has proven itself.

## Review status

Per `docs/delivery.md`, each slice gets a UI/UX review and then a technical review.

| Surface                                           | UI/UX                                                    | Technical                                  |
| ------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------ |
| Merged #263 surface (composer, settings, pickers) | done; its P2/P3 fixes merged in `d3b8f5b`                | done; merged in `88444cd`, copy still open |
| Tabs (`feat/263-tabs`)                            | done; two P1s and eight P2s fixed in `d149684`           | done; merged in `0150b3b`                  |
| Settings recipes (`feat/263-kit-settings`)        | done; visually neutral, two claimed differences          | done; merged in `e13a482`                  |
| Drafts (`feat/263-drafts`)                        | done; one P1 and three P2s fixed in `cdf010f`            | done; merged in `8263d43`                  |
| Settled shelf (`feat/263-settled-shelf`)          | done; one P1 and two P2s fixed in `f35972f`              | done; merged in `c632d16`                  |
| Chat transcript (`feat/263-chat-transcript`)      | done; one P1, three P2s and six P3s fixed in `92b4c17`   | in progress                                |
| Task menu (`feat/263-task-menu`)                  | done; two P1s fixed (Settle removed, focus after remove) | done; merged `0490416`                     |

### Technical review triage

The technical pass on the merged surface returned no P0, five P1 and eight P2. Disposition:

| Finding                                                  | Sev | Disposition                                                                       |
| -------------------------------------------------------- | --- | --------------------------------------------------------------------------------- |
| Wire protocol stays at 13 after incompatible additions   | P1  | Fix now: bump the version and the handshake fixtures                              |
| Create completion clears whichever draft is open         | P1  | Fix now: tie the completion to its submission                                     |
| Disabled named instances stay selectable                 | P1  | Fix now; the server already refuses them                                          |
| Save acknowledgement can lose to an older watch snapshot | P1  | Fix now: one owner for saved state                                                |
| Verification gap and a deleted live-model test           | P1  | Restore the test now; the prefix-binding suite after tabs                         |
| Duplicate virtual keys when favorites span providers     | P2  | Fix now                                                                           |
| Instance rail moves selection without DOM focus          | P2  | Fix now: real roving focus                                                        |
| A removed project renders as scratch but submits its id  | P2  | Fix now                                                                           |
| Base-branch picker uses the checkout-only inventory      | P2  | Fix now: a base-ref read, with the protocol bump                                  |
| Worktree base leaks into the Current checkout row        | P2  | Fix now                                                                           |
| Settings re-skins kit controls from module CSS           | P2  | Follow-up slice after `feat/263-review-fixes`: move the recipes into kit variants |
| Directory truncation warning dropped in Add project      | P2  | Fix now                                                                           |
| Show all / Hide all erase saved ordering                 | P2  | Fix now                                                                           |

Status: every row is merged on the feature branch. Create completion versus draft ownership (P1),
duplicate virtual keys when favorites span providers (P2) and roving focus in the instance rail (P2)
landed in `ae0cd2f`/`262d1b4`; the settings control recipes landed in `e13a482` together with a UI
gate rule that rejects a module stylesheet selecting on a kit `data-slot`.

## Open decisions

1. Favorites: extend the entry with a display name and apply it across instances?
2. ~~Drafts~~ — resolved: one per project and reused (T3), device-local, closing the tab discards
   with `Discarded`/`Undo`, Escape keeps, and a reload restores the text on the next New task.
3. Attachments and pre-launch reasoning: separate issues, or extend the protocol inside #263?
4. Title-only creation: add the control or document that a prompt is required.
5. What happens to the 21 failing legacy browser files: port them to the new shell, delete the ones
   whose surface no longer exists, or keep them red. This is the largest remaining risk to every
   later slice's evidence.
6. Which remaining Corral-only strings stay. The UI/UX review of the merged surface flagged these as
   authored copy with no reference match, and left them unchanged pending your word:
   `settings-sections.ts:20,25,30,60` (the four settings section descriptions),
   `model-management.tsx:583` (the model-ordering paragraph), `task-composer.tsx:229` (placeholder
   `What should the agent do?`), and `task-composer.tsx:249,281` (the disabled attach/reasoning
   hints). Reference wording exists for the placeholder (`Ask anything…`, OpenCode
   `packages/app/src/runtime/i18n/en.ts:351`) but not for the hints. The tabs slice added
   `Companion tabs`, `Resize companion group` and four refusal lines: "The primary session is not a
   closable view; remove it with Remove session.", "The primary session is not moved between
   groups.", "Changes stays in the companion group.", "The main group keeps its only tab."
