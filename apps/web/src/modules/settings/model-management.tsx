import type { ChatModel } from "@corral/protocol/chat";
import {
  defaultModelPolicy,
  matchesModel,
  modelKey,
  modelScopeKey,
  modelVisible,
  providerDenied,
  setModelVisible,
  setProviderVisible,
  toggleModelFavorite,
  type ModelContext,
  type ModelPolicy,
  type ModelPreferences,
  type ModelScope,
} from "@corral/protocol/models";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Button,
  Checkbox,
  Combobox,
  ComboboxButton,
  ComboboxContent,
  ComboboxItem,
  ComboboxList,
  FormError,
  Input,
  ModelPicker,
  useTruncatedText,
} from "../../common/ui/index.ts";
import { useCorralClient } from "../connection/index.ts";
import { useConfig } from "../keymap/index.ts";
import { AgentKind } from "@corral/protocol/config";
import { useModelCatalog, useModelPreferences, type KnownModelCatalog } from "./model-catalog.ts";

export interface ModelManagementTarget {
  scope: ModelScope;
  context: ModelContext;
  known?: KnownModelCatalog;
}
const HOME = "server-home";

export function ModelManagement({
  active,
  target,
  onDirty,
  onBusy,
}: {
  active: boolean;
  target?: ModelManagementTarget | undefined;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const client = useCorralClient();
  const config = useConfig();
  const projects = useSyncExternalStore(
    client.projects.subscribe,
    client.projects.getSnapshot,
  ).projects;
  const options = [
    ...AgentKind.options.map((kind) => ({ scope: { kind, profileId: null }, name: kind })),
    ...config.profiles.map((profile) => ({
      scope: { kind: profile.agent, profileId: profile.id },
      name: profile.name,
    })),
  ];
  const [scope, setScope] = useState<ModelScope>(
    () => target?.scope ?? { kind: "pi", profileId: null },
  );
  const [context, setContext] = useState<ModelContext>(target?.context ?? {});
  const [dirty, setDirty] = useState(false);
  const [switchError, setSwitchError] = useState(false);
  const option = options.find((o) => modelScopeKey(o.scope) === modelScopeKey(scope));
  const profile = config.profiles.find((p) => p.id === scope.profileId && p.agent === scope.kind);
  const inventory = useModelCatalog(
    { scope, context, ...(profile ? { expectedProfileRevision: profile.revision } : {}) },
    active,
    target?.known,
  );
  const changeScope = (key: string | null) => {
    if (dirty) {
      setSwitchError(true);
      return;
    }
    const choice = options.find((o) => modelScopeKey(o.scope) === key);
    if (choice) {
      setScope(choice.scope);
      setSwitchError(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Combobox
          items={options.map((o) => modelScopeKey(o.scope))}
          value={modelScopeKey(scope)}
          onValueChange={changeScope}
        >
          <ComboboxButton layout="bounded" aria-label="Model tool/profile">
            {option?.name ?? scope.profileId ?? scope.kind}
          </ComboboxButton>
          <ComboboxContent>
            <ComboboxList>
              {options.map((o) => {
                const key = modelScopeKey(o.scope);
                return (
                  <ComboboxItem key={key} value={key}>
                    {o.scope.kind} · {o.name}
                  </ComboboxItem>
                );
              })}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        <Combobox
          items={[
            HOME,
            ...(target?.context.taskId ? ["current-task"] : []),
            ...projects.map((p) => p.id),
          ]}
          value={context.taskId ? "current-task" : (context.projectId ?? HOME)}
          onValueChange={(id) => {
            if (id)
              setContext(
                id === HOME
                  ? {}
                  : id === "current-task"
                    ? { taskId: target?.context.taskId }
                    : { projectId: id },
              );
          }}
        >
          <ComboboxButton layout="bounded" aria-label="Catalog workspace">
            {context.taskId
              ? "Current task workspace"
              : (projects.find((p) => p.id === context.projectId)?.name ?? "Server home")}
          </ComboboxButton>
          <ComboboxContent>
            <ComboboxList>
              <ComboboxItem value={HOME}>Server home</ComboboxItem>
              {target?.context.taskId && (
                <ComboboxItem value="current-task">Current task workspace</ComboboxItem>
              )}
              {projects.map((p) => (
                <ComboboxItem key={p.id} value={p.id}>
                  {p.name}
                </ComboboxItem>
              ))}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </div>
      <p className="m-0 shrink-0 text-xs text-muted-foreground">
        Shared per tool/profile. Menu visibility, not permissions. Discovery may load native
        plugins; no prompt is sent. Corral does not edit native config.
      </p>
      {switchError && dirty && (
        <FormError>Save or discard the draft before editing another profile.</FormError>
      )}
      <ModelPolicyEditor
        key={modelScopeKey(scope)}
        scope={scope}
        catalog={inventory.catalog?.models ?? []}
        status={inventory.catalog?.message ?? (inventory.loading ? "Loading native models…" : "")}
        loaded={inventory.catalog !== undefined}
        refreshing={inventory.refreshing || inventory.loading}
        refresh={inventory.refresh}
        onBusy={onBusy}
        onDirty={(value) => {
          setDirty(value);
          onDirty(value);
        }}
      />
    </div>
  );
}

function ModelName({ name }: { name: string }) {
  const { observe, clipped } = useTruncatedText(name);
  return (
    <span ref={observe} className="block min-w-0 truncate" title={clipped ? name : undefined}>
      {name}
    </span>
  );
}

function ModelPolicyEditor({
  scope,
  catalog,
  loaded,
  status,
  refreshing,
  refresh,
  onDirty,
  onBusy,
}: {
  scope: ModelScope;
  catalog: readonly ChatModel[];
  loaded: boolean;
  status: string;
  refreshing: boolean;
  refresh: () => void;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const client = useCorralClient();
  const latest = useModelPreferences(scope);
  const [base, setBase] = useState<ModelPreferences>(() => ({
    scope,
    revision: latest.revision,
    policy: latest.policy,
  }));
  const [policy, applyPolicy] = useState<ModelPolicy>(base.policy);
  const setPolicy = (next: ModelPolicy) => {
    applyPolicy(next);
    onDirty(JSON.stringify(next) !== JSON.stringify(base.policy));
  };
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<string>();
  const [view, setView] = useState("all");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [preview, setPreview] = useState(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const statusLine = useRef<HTMLSpanElement>(null);
  const returnFocus = useRef<"status" | "save" | null>(null);
  const dirty = JSON.stringify(policy) !== JSON.stringify(base.policy);
  if (!dirty && latest.revision > base.revision) {
    const next = { scope, revision: latest.revision, policy: latest.policy };
    setBase(next);
    applyPolicy(next.policy);
  }
  const providers = [...new Set(catalog.map((m) => m.provider))];
  const selectedProvider = providers.some((p) => JSON.stringify(p) === provider)
    ? provider
    : undefined;
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = catalog.filter(
    (m) =>
      (selectedProvider === undefined || JSON.stringify(m.provider) === selectedProvider) &&
      terms.every((term) =>
        (m.name + " " + m.id + " " + (m.provider ?? "")).toLowerCase().includes(term),
      ) &&
      (view === "all" ||
        (view === "visible" && modelVisible(policy, m)) ||
        (view === "hidden" && !modelVisible(policy, m)) ||
        (view === "favorites" && policy.favorites.some((f) => modelKey(f) === modelKey(m)))),
  );
  const visible = catalog.filter((m) => modelVisible(policy, m));
  const missing = (["allow", "deny"] as const).flatMap((action) =>
    [...new Map(policy[action].map((rule) => [JSON.stringify(rule), rule])).values()]
      .filter((rule) => !catalog.some((m) => matchesModel(rule, m)))
      .map((rule) => ({ action, rule })),
  );
  const save = async () => {
    if (busy || !latest.loaded) return;
    const fromSave = document.activeElement === saveButton.current;
    setBusy(true);
    onBusy(true);
    setFailure(undefined);
    try {
      const next = await client.connection.api.models.save({
        scope,
        revision: base.revision,
        policy,
      });
      setBase(next);
      applyPolicy(next.policy);
      onDirty(false);
      if (fromSave) returnFocus.current = "status";
    } catch {
      setFailure(
        "Could not save. Your draft is intact. If another client changed these preferences, load the latest version before retrying.",
      );
      if (fromSave) returnFocus.current = "save";
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  // Disabling Save for the request drops the keyboard to the body, so return it to the outcome
  // (or to Save when the request failed) unless the user moved it while the save was in flight.
  useEffect(() => {
    const target = returnFocus.current;
    if (!target || (target === "status" && dirty) || (target === "save" && busy)) return;
    returnFocus.current = null;
    if (document.activeElement !== document.body) return;
    (target === "status" ? statusLine.current : saveButton.current)?.focus();
  }, [busy, dirty]);
  const discard = () => {
    const next = { scope, revision: latest.revision, policy: latest.policy };
    setBase(next);
    applyPolicy(next.policy);
    onDirty(false);
    setFailure(undefined);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" aria-label="Model visibility editor">
      <div
        className="flex shrink-0 flex-wrap items-center justify-between gap-2"
        role="group"
        aria-label="Model visibility mode"
      >
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant={policy.mode === "all" ? "secondary" : "ghost"}
            aria-pressed={policy.mode === "all"}
            disabled={busy || !latest.loaded}
            onClick={() => setPolicy({ ...policy, mode: "all" })}
          >
            All except…
          </Button>
          <Button
            size="sm"
            variant={policy.mode === "allow" ? "secondary" : "ghost"}
            aria-pressed={policy.mode === "allow"}
            disabled={busy || !latest.loaded}
            onClick={() => setPolicy({ ...policy, mode: "allow" })}
          >
            Only selected
          </Button>
        </div>
        <span className="text-xs text-muted-foreground" aria-label="Visible model count">
          {visible.length} of {catalog.length} visible
        </span>
      </div>
      <p className="m-0 shrink-0 text-xs text-muted-foreground">
        {policy.mode === "allow"
          ? "New models stay hidden unless their provider is allowed. Selecting individual models does not allow future siblings."
          : "New models appear unless their provider or exact ID is excluded."}{" "}
        Exclusions win.
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <Input
          aria-label="Find models"
          placeholder="Find models, IDs or providers…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Combobox
          items={["all", "visible", "hidden", "favorites"]}
          value={view}
          onValueChange={(value) => value && setView(value)}
        >
          <ComboboxButton aria-label="Model rows">{view}</ComboboxButton>
          <ComboboxContent>
            <ComboboxList>
              {["all", "visible", "hidden", "favorites"].map((v) => (
                <ComboboxItem key={v} value={v}>
                  {v}
                </ComboboxItem>
              ))}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        <Button size="sm" variant="ghost" disabled={refreshing} onClick={refresh}>
          Refresh
        </Button>
      </div>
      {status && (
        <p className="m-0 shrink-0 text-xs text-muted-foreground" role="status">
          {status}
        </p>
      )}
      <div className="flex min-h-32 flex-1 overflow-hidden rounded-lg border border-border">
        <nav
          aria-label="Model providers"
          className="flex w-36 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border p-1"
        >
          <Button
            size="sm"
            layout="navigation"
            variant={selectedProvider === undefined ? "secondary" : "ghost"}
            onClick={() => setProvider(undefined)}
          >
            All providers
          </Button>
          {providers.map((p) => {
            const group = catalog.filter((m) => m.provider === p);
            const count = group.filter((m) => modelVisible(policy, m)).length;
            const key = JSON.stringify(p);
            const denied = providerDenied(policy, p);
            const wholeProvider =
              !denied &&
              (policy.mode === "all" ||
                policy.allow.some((rule) => rule.type === "provider" && rule.provider === p));
            return (
              <div key={key} className="flex min-w-0 items-center gap-1">
                {p !== null && (
                  <Checkbox
                    aria-label={`Show provider ${p} including future models`}
                    checked={wholeProvider && count === group.length}
                    indeterminate={!denied && (wholeProvider ? count < group.length : count > 0)}
                    disabled={busy || !latest.loaded}
                    onCheckedChange={(value) => setPolicy(setProviderVisible(policy, p, value))}
                  />
                )}
                <Button
                  size="sm"
                  layout="tree"
                  variant={selectedProvider === key ? "secondary" : "ghost"}
                  onClick={() => setProvider(key)}
                >
                  <span className="min-w-0 flex-1">
                    <ModelName name={p ?? "Ungrouped"} />
                  </span>
                  <span className="text-xs">
                    {count}/{group.length}
                  </span>
                </Button>
              </div>
            );
          })}
        </nav>
        <div
          className="min-w-0 flex-1 overflow-y-auto"
          aria-label="Catalog models"
          aria-busy={refreshing}
        >
          {!loaded ? (
            <p className="p-3 text-xs text-muted-foreground">Loading is not an empty catalog.</p>
          ) : rows.length === 0 ? (
            <div className="p-3 text-xs text-muted-foreground">
              {query ? (
                <>
                  No matches.{" "}
                  <Button size="sm" variant="ghost" onClick={() => setQuery("")}>
                    Clear search
                  </Button>
                </>
              ) : catalog.length === 0 ? (
                "No native inventory is available in this context."
              ) : visible.length === 0 ? (
                "All models are hidden by these rules. The empty allowlist is kept."
              ) : (
                "No models in this view."
              )}
            </div>
          ) : (
            rows.map((model) => {
              const checked = modelVisible(policy, model);
              const excluded = providerDenied(policy, model.provider);
              const favorite = policy.favorites.some((f) => modelKey(f) === modelKey(model));
              return (
                <div
                  key={modelKey(model)}
                  className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2"
                >
                  <Checkbox
                    aria-label={`Show ${model.name} · ${model.provider ?? model.id}`}
                    checked={checked}
                    disabled={busy || !latest.loaded || excluded}
                    onCheckedChange={(value) => setPolicy(setModelVisible(policy, model, value))}
                  />
                  <div className="min-w-0 flex-1">
                    <ModelName name={model.name} />
                    <p className="m-0 text-xs text-muted-foreground">
                      <ModelName
                        name={`${model.provider ? model.provider + "/" : ""}${model.id}`}
                      />
                    </p>
                    {excluded && (
                      <p className="m-0 text-xs text-muted-foreground">
                        Excluded by provider; show the provider first.
                      </p>
                    )}
                  </div>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Favorite ${model.name} · ${model.provider ?? model.id}`}
                    aria-pressed={favorite}
                    disabled={busy || !latest.loaded}
                    onClick={() => setPolicy(toggleModelFavorite(policy, model))}
                  >
                    {favorite ? "★" : "☆"}
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </div>
      {missing.length > 0 && (
        <details className="shrink-0 text-xs text-muted-foreground">
          <summary>{missing.length} rules outside this inventory (kept)</summary>
          <div className="max-h-28 overflow-y-auto">
            {missing.map(({ action, rule }) => (
              <div
                key={`${action}:${JSON.stringify(rule)}`}
                className="flex items-center justify-between gap-2"
              >
                <span className="min-w-0 flex-1">
                  <span>{action === "allow" ? "Allow" : "Exclude"} · </span>
                  <ModelName
                    name={
                      rule.type === "provider"
                        ? rule.provider + " (provider)"
                        : (rule.provider ?? "") + "/" + rule.id
                    }
                  />
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    setPolicy({
                      ...policy,
                      [action]: policy[action].filter(
                        (r) => JSON.stringify(r) !== JSON.stringify(rule),
                      ),
                    })
                  }
                >
                  Remove rule
                </Button>
              </div>
            ))}
          </div>
        </details>
      )}
      {failure && <FormError>{failure}</FormError>}
      {dirty && latest.revision !== base.revision && (
        <FormError>
          Changed in another client. Your draft has not been replaced. Discard it to load the latest
          version.
        </FormError>
      )}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
        <span
          ref={statusLine}
          role="status"
          tabIndex={-1}
          className="rounded-sm text-xs text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
        >
          {dirty ? "Unsaved changes" : "Saved"} · revision {base.revision}
        </span>
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !latest.loaded}
            onClick={() =>
              setPolicy({ ...defaultModelPolicy(), mode: "allow", favorites: policy.favorites })
            }
          >
            Hide all
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !latest.loaded}
            onClick={() => setPolicy({ ...defaultModelPolicy(), favorites: policy.favorites })}
          >
            Show all
          </Button>
          <Button size="sm" variant="outline" onClick={() => setPreview(true)}>
            Preview
          </Button>
          <Button size="sm" variant="ghost" disabled={!dirty || busy} onClick={discard}>
            Discard
          </Button>
          <Button
            ref={saveButton}
            size="sm"
            disabled={!dirty || busy || !latest.loaded}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </div>
      {preview && (
        <ModelPicker
          title="Model visibility preview"
          instances={[
            { key: modelScopeKey(scope), kind: scope.kind, name: scope.profileId ?? scope.kind },
          ]}
          instance={modelScopeKey(scope)}
          onInstance={() => undefined}
          models={visible.map((m) => ({
            key: modelKey(m),
            name: m.name,
            provider: m.provider ?? undefined,
            detail: m.id,
            disabled: true,
          }))}
          onModel={() => undefined}
          unavailable="Preview only. Thinking levels come from the running agent."
          emptyMessage="No models pass this draft's rules."
          footer={
            <span className="text-xs text-muted-foreground">
              Preview of unsaved menu visibility. No session is changed.
            </span>
          }
          onClose={() => setPreview(false)}
        />
      )}
    </div>
  );
}
