import type { ChatModel } from "@corral/protocol/chat";
import {
  defaultModelPolicy,
  modelScopeKey,
  type ModelCatalog,
  ModelCatalogInput,
  type ModelScope,
} from "@corral/protocol/models";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useCorralClient } from "../connection/index.ts";

const DEFAULT_POLICY = defaultModelPolicy();
export interface KnownModelCatalog {
  scope: ModelScope;
  context: ModelCatalogInput["context"];
  profileRevision?: string | undefined;
  models: readonly ChatModel[];
}
export function useModelPreferences(scope: ModelScope) {
  const client = useCorralClient();
  const state = useSyncExternalStore(
    client.modelPreferences.subscribe,
    client.modelPreferences.getSnapshot,
  );
  const saved = state.items.find((item) => modelScopeKey(item.scope) === modelScopeKey(scope));
  return {
    loaded: state.loaded,
    scope,
    revision: saved?.revision ?? 0,
    policy: saved?.policy ?? DEFAULT_POLICY,
  };
}

/** Every render carries provenance; a late previous-profile result can never flash in this picker. */
export function useModelCatalog(
  input: ModelCatalogInput,
  active: boolean,
  known?: KnownModelCatalog,
) {
  const client = useCorralClient();
  const connection = useSyncExternalStore(
    client.connection.state.subscribe,
    client.connection.state.getSnapshot,
  );
  const key = JSON.stringify(input);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    catalog: ModelCatalog;
    refreshing: boolean;
  }>();
  const currentKnown =
    known &&
    modelScopeKey(known.scope) === modelScopeKey(input.scope) &&
    known.context.taskId === input.context.taskId &&
    known.context.projectId === input.context.projectId &&
    known.profileRevision === input.expectedProfileRevision
      ? known
      : undefined;
  useEffect(() => {
    if (!active || currentKnown || connection.status !== "connected") return undefined;
    let live = true;
    setResult((previous) =>
      previous?.key === key ? { ...previous, refreshing: true } : undefined,
    );
    void client.connection.api.models
      .catalog({ ...ModelCatalogInput.parse(JSON.parse(key)), refresh: refresh > 0 })
      .then((catalog) => {
        if (live) setResult({ key, catalog, refreshing: false });
      })
      .catch(() => {
        if (live)
          setResult((previous) => ({
            key,
            refreshing: false,
            catalog:
              previous?.key === key
                ? {
                    ...previous.catalog,
                    status: "stale",
                    message: "Connection lost; showing the previous catalog.",
                  }
                : {
                    models: [],
                    status: "error",
                    fetchedAt: null,
                    message: "Could not load models. Reconnect and retry.",
                  },
          }));
      });
    return () => {
      live = false;
    };
  }, [client, key, active, currentKnown !== undefined, refresh, connection.status]);
  const reported: ModelCatalog | undefined = currentKnown
    ? {
        models: [...currentKnown.models],
        status: "ready",
        fetchedAt: null,
        message: "Reported by the running chat.",
      }
    : result?.key === key
      ? result.catalog
      : undefined;
  return {
    catalog: reported,
    loading: active && !reported,
    refreshing: !currentKnown && result?.key === key && result.refreshing,
    refresh: () => setRefresh((value) => value + 1),
  };
}
