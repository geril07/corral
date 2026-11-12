# UI rebuild — status and open decisions

The rebuild was merged in #264. This file records remaining decisions and limitations, not an
authorization to start another slice. Product decisions are in `design.md`, current placement in
`layout.md`, and the rebuild review process in `delivery.md`. Git history and
the issues own completed slice plans and review records.

The visual direction remains T3 for structure and behavior, OpenCode for visual language, with one
implementation per shared pattern and no invented user-visible copy. See `delivery.md` and
`ui-kit.md` for the rules and provenance.

## Open decisions

- Model favorites across instances need a display-name and cross-instance application rule.
- Real attachments and pre-launch reasoning need separate contract decisions. Both controls are
  disabled today; reasoning levels currently come from a running chat.
- Title-only task creation remains supported by the server but not exposed by the routed composer,
  which requires a prompt. Whether to expose a title control remains open.
- Chat-start polish, including focus intent, a device-local last-used model, headline and create
  gating wording, is not authorized by this cleanup.
- The following Corral-only strings remain unresolved: the four settings section descriptions
  (`settings-sections.ts`), the model-ordering paragraph (`model-management.tsx`), the task prompt
  placeholder and disabled attach/reasoning hints (`task-composer.tsx`), and the tab labels
  `Companion tabs`, `Resize companion group` and refusal lines for closing or moving the primary
  tab, moving Changes, and moving the only main tab. Reference wording for the placeholder exists;
  the disabled hints have no reference wording.
- Settle is left as implemented for now. The earlier accepted C2 lifecycle differs from that
  implementation; see `design.md` for the discrepancy and provenance. A change needs a separate
  decision.

## Known limitations

- Issue #265 tracks mixed old-interface tests. Live behavior, including Changes writes, links,
  session lifecycle and handoff, must be ported rather than bulk-deleted. Electron helpers and
  specs also need migration. No old or partial run is a green release gate.
- Opening a local file in chat starts the configured editor in a loose terminal, but the routed
  shell has no loose-terminal view. The editor-visibility assertion remains a failing live check;
  its product fix is outside #265.
- The open Settled shelf mounts every settled row in one scroller; a very long history has a
  corresponding rendering cost. `Project settings…`, project removal and loose-terminal controls
  have no routed-shell entry point. The `/board` route still mounts the earlier board and its
  most-urgent-session aggregate, but the routed shell has no entry point to it. The routed shell
  also does not mount the connection status/recovery opener; a refused capability reaches the
  terminal's own notice, not a capability field over a running workspace.
- The composer does not support real attachments or pre-launch reasoning. A scratch task has no Git
  controls; mobile remains out of scope.
- The transcript keeps all turn folds open while the session is working because the protocol does
  not reliably distinguish delivered steers from new prompts. Timestamps and forks need protocol
  work. Earlier copy-action mounting and 5,000-item timing failures limit confidence despite later
  passing runs.
