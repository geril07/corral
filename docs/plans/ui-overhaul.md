# UI overhaul: approved prototype → production

The user accepted study 03 on 2026-11-03
(`apps/web/src/modules/workspace/ui-overhaul.prototype.html`).
T3 Code is the visual reference; Orca is an interaction reference, not a second theme.
No preview/render tools from the previous harness are required.

## Slice 1: workspace chrome

- T3-like dark surfaces, blue actions and restrained borders in the shared kit.
- Project grouping by default; status grouping remains a device preference.
- Wordmark and sidebar toggle; one bottom, scrollable Settled shelf with pagination.
- Separate task header and always-present session strip. Compact tabs have context menus,
  not hidden-width stop/menu/close slots. Chat/Terminal uses the existing safe handoff action.
- Settings is a large, categorized route-backed modal over a mounted workspace.
  One category is visible at a time, with independent scroll and retained disclosure state.
  Workspace drafts, session identity, selection and scroll survive. Background prefix actions pause.
- Unsent chat text is owned by the workspace per session, not by the conditional chat view.
  Switching sessions or Chat/Terminal retains it; successful sends clear only the text sent.
  This is in-memory state, not reload persistence.
- Device-local tab position and interface text scale. Font scaling uses rems, not a CSS
  transform, so popup coordinates remain native; terminal font remains independently 14 px.
- Full accessible names and tooltips on clipped text; real tool logos with attribution.

## Slice 2: composers and model picker

- New-task and chat prompts share the composer frame/control row. Task creation and add-agent
  share one launch selection, view controls and tool/profile/model picker.
- Chat is the built-in task/add-agent UI default. Explicit terminal settings still win;
  missing chat drivers fall back to terminal. Prompt creation waits for capability discovery.
  API calls that omit `sessions.start.view` retain their terminal behavior.
- Existing-task composers never change repository, branch or checkout. Optional titles remain.
  From issue moves behind Task setup actions rather than occupying everyday creation.
- The shared picker has a tool/profile rail, searchable model list and reported thinking column.
  Same-session model selection previews immediately and stays open; thinking applies and closes.
  Levels from the previous model are hidden until the selected model is reported. Selecting
  another tool/profile creates a distinct session and preserves the original session's draft.
- Running chats use driver-reported catalogs and levels. Pre-launch uses native/configured
  defaults and supported native model-ID overrides only; OpenCode remains env-only.
  No sample favorites, provider catalog, Full access permissions or context counters ship.
- Launch selections pin the profile revision, including while editing a raw model override.
  Changed/deleted profiles and disabled agents require explicit reselection, not silent fallback.
- Keep existing send/steer/follow-up and IME semantics until the send shortcut is agreed.

## Remaining contract work

- Pre-launch model discovery and thinking are not exposed by the current protocol. Define
  profile-scoped discovery and its process/config side effects before adding a catalog. Initial
  thinking needs an explicit launch field validated/applied before the first prompt; account
  for older daemons that would otherwise silently strip it. The current UI says it is unavailable.
- Real context consumption is absent from the chat contract. Add measured driver data before
  optional context UI; never substitute the prototype's numbers.

Changes UI, path expansion/discovery/preview, account isolation and permission policy are not
part of this overhaul. Existing Changes and imported-source access must keep working.

## Verification

`pnpm check`, full `pnpm test:browser`, and `pnpm test:e2e`.
Also inspect the running web interface at 1920×1080 and 1024×640, including the unified launch,
model/thinking, profile-to-session flow, drafts, focus and popup bounds. Use isolated test data and
fake agents; no paid model calls or user's live sessions. Slice reports/evidence live under
`.e2e/ui-overhaul-slice1/` and `.e2e/ui-overhaul-slice2/`.
