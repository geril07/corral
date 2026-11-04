# Model discovery and visibility — design study

Status: **research archive**. Direction A and server-shared per-tool/profile preferences were
approved for implementation after this study. The historical proposals/open questions below are
preserved; the implemented contract and remaining limits are in [Model catalogs](../model-catalog.md).
Collected 2026-11-04.
Production baseline: commit `7a14fe7`. No agent/provider calls were made for this study.

Question: how should a user choose a real model/thinking before launch, while keeping large
pi/OpenCode catalogs manageable through provider/model allowlists and denylists?

## 1. Verified references

Local references: T3 Code `550c5fa34`, Orca `25994e0b9`. Paths below are relative to each repo.
External documentation describes current upstream interfaces, **not proof that the exact installed
native CLI versions work**. Corral currently gates Claude at 2.1.316 and Codex at 0.166.0.

### T3 Code

- `packages/contracts/src/settings.ts:334–349`: favorites use `(instanceId, model)`;
  `providerModelPreferences[instanceId]` stores `hiddenModels` and `modelOrder`.
- `apps/web/src/components/settings/ProviderModelsSection.tsx:87–100`: Disable all snapshots
  the currently known built-in slugs. It does not create a future-proof allowlist.
- The same section has text search, per-model visibility, favorites, ordering, and bulk controls
  (`:265–378`). It is a larger settings editor, not a complicated everyday picker.
- `apps/web/src/modelSelection.ts:125–138`: ordinary hidden models are removed before ordering.
  Custom models bypass that hide filter. Do not inherit this exception accidentally in Corral.
- `apps/web/src/hooks/useSettings.ts:425–453`: model preferences now save to the selected server
  environment; old client-local preferences have a migration path. Per-device storage is not the
  only pattern in current T3.
- `packages/provider-pi/src/server/status.ts:141–192`: short-lived ephemeral RPC discovery, with
  the instance environment and cwd. No real T3 thread is needed to read the inventory.
- `packages/provider-opencode/src/server/status.ts:483–514`: a cold OpenCode catalog can be
  partial. The loader keeps a useful cache and waits for stable reads within a deadline.
- Pi thinking capabilities in T3 are derived from reported model metadata plus T3's own mapping
  rules (`packages/provider-pi/src/server/thinkingCapabilities.ts`). Corral's stricter
  driver-reported-level requirement should not silently become a copied mapping table.

### Orca

- `src/renderer/src/components/native-chat/NativeChatModelCombobox.tsx:32–102`: searches all
  terms as substrings without reordering native choices; keeps search focus during writes;
  distinguishes read-only from a temporarily busy write. A stable check slot prevents reflow.
- `src/main/native-chat/agent-model-catalog/agent-model-catalog-discovery.ts:6–45`: discovery
  probes are separate from the service that owns cache, refresh, publication and unsupported state.
- `.../agent-model-catalog-scope.ts:16–103`: discovery follows launch configuration/account/cwd,
  not arbitrary picks from another session; saved reads can remain passive.
- `.../agent-model-catalog-effort-discovery.ts:8–47`: model-specific effort requests share in-flight
  work and have bounded retry/partial-attempt lifetimes.
- These are useful lifecycle/search references. The inspected model combobox is not evidence of
  a general Orca provider/model allowlist UI.

### OpenCode — official docs and protocol

- [Provider configuration: hiding models](https://opencode.ai/docs/providers/#hiding-models):
  per-provider `whitelist` keeps named model IDs; `blacklist` removes named IDs. Whitelist is
  applied first, blacklist second.
- [Config](https://opencode.ai/docs/config/): `enabled_providers` allows named providers;
  `disabled_providers` wins on overlap and prevents loading them even if credentials exist.
  This changes native availability, not just Corral's menu. Corral must not edit these files as
  a side effect of a visibility checkbox.
- Current upstream [model protocol](https://github.com/anomalyco/opencode/blob/dev/packages/protocol/src/groups/model.ts)
  exposes `GET /api/model` and `/api/model/default`; the list can precede plugin settlement.
- These docs were also checked through Context7 `/anomalyco/opencode`. Exact compatibility with
  Corral's supported OpenCode version still needs an isolated contract probe.

### Pi — official docs

- [RPC](https://pi.dev/docs/latest/rpc): `pi --mode rpc --no-session` uses an in-memory native
  session. Commands can inspect state without sending a prompt. Close stdin for orderly shutdown.
- [RPC commands](https://pi.dev/docs/latest/rpc-commands): `get_available_models` reports model
  objects; `get_available_thinking_levels` reports levels for the **current model**. A non-reasoning
  model reports `["off"]`, not an invented generic list.
- [CLI](https://pi.dev/docs/latest/cli): `--models` scopes startup/cycling, with exact IDs, fuzzy
  matching and globs. It is not automatically a shared Corral visibility preference.
  `--thinking` may clamp to capabilities: Corral must verify the applied value, not simply echo it.
- An in-memory session is not a security sandbox. Native initialization can load extensions and
  other configured resources. No prompt does not prove no startup side effects.

### Codex and Claude — official docs

- [Codex model/list](https://learn.chatgpt.com/docs/app-server#list-models-modellist) returns paged
  models, supported reasoning efforts, suggested defaults and a native `hidden` hint. It can be
  called after connection initialization without creating a work thread. Hidden hints are not
  equivalent to denied access. All pages must be read before declaring a complete catalog.
- [Claude Query](https://code.claude.com/docs/en/agent-sdk/typescript#query-object) offers
  `supportedModels()`; [ModelInfo](https://code.claude.com/docs/en/agent-sdk/typescript#modelinfo)
  includes accepted effort levels when supplied by the native CLI.
- Corral's current Claude driver already reads models before its first prompt; waiting for
  `system:init` instead would deadlock (`apps/server/src/chat/claude-driver.ts:192–195`).
- Corral's current Codex/OpenCode drivers explicitly refuse live model/effort switching. Upstream
  APIs are evidence of possible integration work, not a claim that those Corral adapters support it.

## 2. Three independent layers

1. **Native inventory**: what this executable/profile/workspace reports. Native config, credentials,
   disabled providers and supported CLI versions belong here. Never invent entries to fill a list.
2. **Persistent visibility**: which reported entries the user wants in Corral menus. Not an auth
   boundary; does not change native config, stop sessions, or rewrite launch snapshots.
3. **Temporary search/view**: search terms, provider focus, favorites-only view. Does not save a
   permanent visibility rule or expose permanently hidden entries implicitly.

Keep the inventory intact. Creation, add-agent and live-chat pickers use one visibility projection;
server validation uses real native capabilities, not the user-curated menu.

Discovery, launch-time selection and live switching are separate capabilities. A returned model is
not proof that our current adapter can select it before a prompt. Honor existing pinned-provider
launch rules: a visibility preference must not silently override a profile's provider. Where the
native agent does not report provider groups, use its actual model identity and omit the provider
rail rather than inventing grouping or routing from names.

## 3. Recommended first policy

**Proposal:** an instance-scoped allowlist/denylist, with two readable modes:

- **All except…**: newly discovered models appear unless excluded.
- **Only selected…**: newly discovered models appear only if an allow rule matches.

Rules target a reported provider ID or a precise `(provider, modelId)`, never display names.
A provider rule includes future models for that provider. A model rule affects that exact ID.
For the initial design, use exact IDs/provider groups, not regex/glob syntax.

```text
visible = native_inventory
          ∩ (all, or matching allow rules in Only selected mode)
          − matching deny rules
```

A deny wins, following OpenCode's native convention. An explicit empty allowlist in Only selected
mode means **show none**, not reset to all. Do not conflate it with no saved preference.

Consequences the UI must explain:

- Allow provider + hide one model works.
- Hide provider + allow one of its models remains hidden. The model checkbox says the provider
  excludes it; the provider must be unhidden first. This is deliberately not a hidden specificity
  cascade. If that interaction feels wrong in the prototype, reconsider the rule model explicitly.
- A provider-wide Show all action removes that provider's deny and per-model exclusions; a
  provider-wide Hide action creates a provider exclusion. Bulk actions affect the whole provider,
  not just the current search result. A filtered subset bulk action would need its own label.
- The provider count can be mixed: some models individually allowed, or a provider allowed with
  per-model exclusions. Mixed is not the same as an explicit provider-wide allow rule.
- New models are evaluated against saved rules; do not store a snapshot of all current IDs to
  approximate a provider rule.
- A missing native model can keep its saved rule/favorite, labeled Not in current inventory.
  Do not delete user preferences merely because discovery temporarily returned less data.

## 4. Scope, storage and identity

**Recommended, still unapproved:** server-owned model UI preferences, shared by browser/desktop
clients connected to that server. Keep them separate from read-only `config.toml` and native config.
Use the existing SQLite/typed-RPC patterns rather than another config parser or native file writes.

- Preference identity: native tool or stable launch-profile ID, namespaced by agent kind.
  Not a display name, model label, profile revision, or executable's array position.
- Discovery cache identity: effective command/version, profile revision/effective environment scope
  and actual cwd/config context. Never share Work and Personal results just because both are pi.
  Never expose resolved environment values to clients or diagnostics.
- Profile edits preserve that profile's preferences, but invalidate/re-scope discovery. A profile ID
  reassigned to a different agent is a different preference namespace.
- Request provenance and current generation prevent a slow previous-profile result replacing the
  newly selected profile's inventory or thinking list.
- No per-project visibility overrides or device-local override cascade in the first slice. Catalog
  contents can still be project-dependent. Additional preference layers require a demonstrated need.

Shared vs device-local preferences remains a user decision; the prototype assumes shared.
For shared editing, use the project's expected-revision pattern per instance: saving stale preferences
must preserve the editor draft and report the conflict, not overwrite another client's changes.
Preference revision and launch-profile revision are different facts.

## 5. Proposed interaction and appearance

Preserve the approved workspace chrome and tool/profile → model → thinking picker.
The everyday picker should stay a chooser, not become a settings table.

### Variant A — Settings manager (recommended)

Picker footer: `Visible X of Y · Manage models…`. Settings opens the Models category over the
mounted workspace. Remember draft, selected session, caret, picker search and opener.

- Stable tool/profile selector; All except / Only selected mode.
- Provider sidebar with visible/known counts and mixed-state bulk controls.
- Searchable model table: visibility checkbox, real name + ID, provider and favorite.
- Explicit reason when a provider exclusion overrides a model rule.
- Optional All / Visible / Hidden view; this is temporary, not another saved rule.
- Preview of the resulting picker and explicit Save/Cancel while editing. This does not introduce
  an Apply button into the everyday model/thinking picker. A manager draft prevents exploratory
  whitelist-mode/bulk edits from immediately emptying menus on every connected client.
- Explain future-model behavior under the mode control, not in a tooltip.

### Variant B — Manage in picker

An explicit management mode expands the anchored picker and replaces choosing rows with visibility
controls. A provider dropdown and bulk action replace the Settings sidebar, leaving a wide model
list. Done returns to model choice without losing prompt/search. Fewer transitions, but larger
popups and a stronger risk of confusing Select model with Show model at compact sizes.

### Variant C — Explicit rule editor

Settings shows separate Allow / Hide rule lists and a live result table. Provider-wide rules and
future behavior are very clear; selecting a few favorites from a large inventory takes more steps.
Best if rules/patterns are the main user workflow, not the default recommendation yet.

The prototype varies only the management surface, not the already approved workspace design.
All its data and thinking levels are illustrative. No persistence or agent calls.

Concrete examples to try:

| Saved choice                                               | New model in that provider        | New model elsewhere   |
| ---------------------------------------------------------- | --------------------------------- | --------------------- |
| Only selected + allow OpenAI Codex provider + hide GPT-5.4 | Appears, unless separately denied | Hidden                |
| Only selected + one exact Sonnet ID                        | Hidden                            | Hidden                |
| All except + exclude Google provider                       | Hidden in Google                  | Appears unless denied |
| Only selected + no allow rules                             | Hidden                            | Hidden                |

Use the prototype's New model action to distinguish a provider rule from selecting all existing rows.
A selected favorite does not override any of these rules.

## 6. Important states

| Situation                               | Behavior                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| First inventory load                    | Loading, not empty/no models; prompt stays editable                                                     |
| Refresh in progress                     | Keep previous good inventory and label Refreshing                                                       |
| Refresh failure with cache              | Keep usable data, label stale and offer Retry; launch still validates                                   |
| No inventory and error                  | Explain failure/unsupported version; no fabricated models or levels                                     |
| Complete empty native inventory         | No models reported; distinguish from Corral filtering                                                   |
| Partial catalog                         | Mark incomplete; do not use it to erase rules or claim all providers are known                          |
| All entries filtered                    | Show count and Manage models; do not silently reset visibility                                          |
| Search has no match                     | Clear search; do not offer Reset filters as if permanent rules failed                                   |
| Current model becomes hidden            | Keep current model/turn/draft; label Hidden by filter; no auto-switch                                   |
| Favorite becomes hidden                 | Keep its favorite record, but do not bypass visibility in the picker                                    |
| Profile renamed/revised                 | Preserve preferences; refresh scoped inventory; revalidate launch revision                              |
| Save failure                            | Retain unsaved draft; clear error/Retry; do not pretend other clients received it                       |
| Thinking loading/failure                | No previous model's levels; separately distinguish unknown from none                                    |
| Native model rejects requested thinking | Refuse before first prompt, or report actual native result; never display the requested string as proof |
| Compact viewport                        | No horizontal page scroll; modal/popup and internal lists fit available height                          |

Changing visibility never cancels a working turn or clears a draft. A current hidden selection stays
usable because this is a menu preference, not a deny-access policy. The profile being edited in
Settings is separate from the session's profile and the picker context to return to; changing the
Settings target cannot silently select another tool/profile in the workspace.

## 7. Discovery and launch sequencing

Recommended architecture, to validate before implementing:

1. Server resolves exactly the chosen executable/profile, with the same safe environment-reference
   resolution as launch. Return explicit unsupported/missing/auth/error information when known.
2. Native adapter supplies inventory and, where required, selected-model effort lookup. The service
   owns deadlines, duplicate in-flight requests, bounded process lifetime, cache and freshness.
3. For pi, obtain selected-model thinking in an isolated metadata runtime: selecting a probe model
   must never mutate the user's working session. Serialize/query by identity so concurrent clients
   cannot read the wrong probe model's levels. Do not infer a global vocabulary.
4. An uncreated worktree cannot be probed as if it already existed. A project-root inventory is
   provisional for that launch; validate in the actual workspace after creation and before prompt.
5. Start receives a single coherent model/thinking selection and pinned profile revision. Apply it
   through the native driver before delivering the first prompt; errors cannot silently fall back.
6. Initial selection and current session settings are different lifecycle facts. Resume/handoff must
   not reapply an initial effort over a later user change without an explicit policy.
7. Older daemons must reject/advertise unsupported launch fields rather than silently strip them.

Corral's pi driver currently retains old thinking levels if model-state refresh fails
(`apps/server/src/chat/pi-driver.ts:209–214`). This is a code-inspection finding, not a reproduced
runtime failure in this study. Add a failure-path regression and invalidate stale capabilities before
extending pre-launch behavior.

## 8. Open decisions and suggested delivery

1. Approve management placement: A, B, C, or a focused combination.
2. Approve shared server preferences vs device-local settings.
3. Approve native metadata process startup policy. Recommended lazy on intentional picker/catalog
   use, no work thread/task/worktree and no prompt. Native extension/MCP startup side effects need
   a documented boundary; no-session alone is not a sandbox.
4. Check whether strict deny-over-allow provider behavior feels right. Do not quietly change it to
   a more-specific-rule cascade after implementing the UI.

Suggested order: fix stale model capabilities; one end-to-end pi discovery/visibility/initial-effort
slice; Claude; Codex/OpenCode integration measured against supported versions. Context consumption
remains a separate slice. No native config editing, permissions UI, account-isolation redesign,
regex rule language, or provider price/capability guesses in this work.

Prototype: `apps/web/src/modules/settings/model-visibility.prototype.html`.
Run: `python3 -m http.server 5201 --bind 127.0.0.1 --directory apps/web/src/modules/settings`,
then `/model-visibility.prototype.html?variant=A` (or B/C). Its state is memory-only.
