# Model catalogs and menu preferences

Approved direction: study A, a Models category in mounted Settings, linked from the ordinary
model picker. The [research study](research/model-catalog.md) records the references and alternatives.

## Visibility, not permissions

Preferences are shared by clients of this Corral server in `models.toml`, beside `config.toml`,
not in SQLite or an agent's native config. The separate model-preference file lets Settings
save atomically without rewriting comments or unrelated launch settings in the hand-edited
`config.toml`. It is the only preference authority; there is no database import or fallback.
The key is the agent kind plus a stable profile ID (or native defaults).
Renaming/revising a profile preserves preferences; assigning its ID to another agent does not mix
the namespaces. This is not credential/account isolation.

- **All except…** admits new reported models unless excluded.
- **Only selected** admits exact allowed models or models of an allowed provider. An empty
  allowlist deliberately shows none.
- A provider rule includes its future models. Selecting every current model individually does not;
  that provider's checkbox remains mixed until its provider-wide rule is chosen.
- Exclusions always win, including a provider exclusion over an exact model allowance.
- Provider bulk actions cover the provider, not just search matches. Show clears that provider's
  exclusions; Hide excludes it. Global Hide all makes an empty allowlist; Show all resets visibility.
- Search (all terms across name, ID and provider), provider focus and All/Visible/Hidden/Favorites
  views are temporary. Favorites are persisted, ordered first in pickers, and cannot bypass hiding.
- Missing models/providers keep their rules and favorites. Incomplete discovery never deletes them.
- Current selections and configured/native defaults are not rewritten. Hiding a working model does
  not change the model, thinking, prompt, turn or session. A hidden current chat choice is retained
  as a disabled, explicitly labeled row. The manager marks the row used by the configured default
  launch for the selected scope and workspace as **Configured default**, and says when the draft
  would hide it; hiding is not refused and the default is not edited. Native-ID entry remains an
  expert launch override, not an access-policy bypass: there is no access policy here.

The manager edits a draft with Preview, Save and Discard. A profile switch with unsaved edits is
blocked; changing workspace does not discard rules. Closing asks whether to discard; an in-flight
save must finish first. Each save uses an expected preference revision. Another client's save
updates an idle editor, but conflicts never overwrite its draft. When a conflict makes the draft
stale, Save is not offered; Discard loads the latest revision and drops the draft.

`models.toml` has one `[[preferences]]` entry per scope, with a `scope` table (`kind` and optional
`profileId`) and a `policy` table (`mode`, `allow`, `deny`, `favorites`, `providerOrder`, `modelOrder`). Omitted provider/profile
identifiers mean native/default scope: TOML has no null. Missing policy lists are empty and the
default mode is `all`. Favorites retain their own array order ahead of ordinary models, which
group by `providerOrder` and then `modelOrder`. Unlisted providers retain first-seen order and
unlisted models retain reported order within their group; missing entries remain in the config.
External edits, including atomic
file replacements, update clients. Revision tokens derive from content, so changing a policy
without manually updating a counter still conflicts with an outstanding Settings draft. An
unreadable, malformed or duplicate-scope config is an error, never permission to overwrite it.
Settings normalizes this dedicated file's formatting and comments when saving.

Creation, add-agent and live chat use the same visibility predicate. Managing preferences from
a picker temporarily suspends that popup, not its owning selection/search state. Returning opens
the original picker/profile/search. The workspace and composer stay mounted. Both routed Settings
and picker-owned Settings pause background workspace actions and completion seen-marking.

## Discovery lifecycle

Discovery is lazy, on opening a picker or visiting Models, not a startup/background scan of profiles.
The workspace selector chooses server home, a known project root, or the actual current task's
workspace. No arbitrary path/environment comes from the client. A future worktree is not treated
as if it already existed.

This slice discovers **pi and OpenCode** before launch. Running chat inventories, including Claude,
can be used in their actual scope/context/profile revision. A different context cannot reuse a
working chat's inventory. Unsupported adapters say so rather than supply a stock catalog.

The server scopes its short in-memory cache by tool/profile, profile revision, executable choice,
cwd and a private hash of the effective environment. Referenced values are resolved as at launch,
never returned, stored in preferences or copied to diagnostics. Native config/auth changes are
picked up by Refresh or the 30-second cache expiry. Requests in flight are deduplicated, at most
two probes run concurrently (24 queued), and at most 64 snapshots remain cached.

- pi reuses its native RPC driver/framing/supervision with `--mode rpc --no-session`, no prompt,
  a private timeline and a metadata-specific process claim. It creates no Corral task/session.
- OpenCode gets a separate short-lived `serve` process per probe, never the server of a working
  session. Authenticated `GET /api/model` is scoped by `location[directory]`; disabled entries
  are excluded. Consecutive agreeing nonempty reads reduce the cold-plugin race, but are not a
  guarantee that every future plugin has settled. Deadline/failed reads retain partial progress.
- A partial smaller result preserves useful cached entries. A failed refresh preserves the last
  useful catalog as stale, without exposing native diagnostics. Initial failure and unsupported,
  partial, stale and complete-empty inventories remain distinct from an empty visibility view.
- Native requests/processes are bounded (8-second production preparation/read budget, exit grace);
  OpenCode responses are limited to 8 MiB including streaming bodies. Processes stop after
  discovery and during server shutdown; persisted PID/start-identity claims recover crash leftovers.

No discovery command sends a model prompt, but **native startup can load extensions/plugins/MCP
and have side effects**. An ephemeral session is not a sandbox. Corral does not modify native config.

## Selection capabilities and limits

Inventory is not selection support. Existing launch/provider validation still wins. A pinned pi
provider cannot be silently replaced by choosing another provider's model. Unsupported launch
rows are disabled with a reason; configured defaults and supported raw native IDs remain available.

This slice does **not** add initial thinking to task/session launch fields, nor model/effort
switching to the current OpenCode/Codex adapters. Pi and Claude live changes keep their existing
driver contracts. Pi clears the old model's thinking state when a switch succeeds but its refresh
fails, so the previous model's capabilities are never offered as the new one's.

The typed `models.watch`, `models.save` and `models.catalog` contract is shared by every client.
Model preference saves require the current content revision and distinguish a concurrent edit
from an invalid config file. Restart the long-lived server after upgrading server code.

Tests use isolated fake external CLIs with the real server, git, SQLite and transport. They are
not certification of native installed versions, provider availability or paid model behavior.
