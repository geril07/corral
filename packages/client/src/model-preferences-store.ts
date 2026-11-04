import type { ModelPreferences } from "@corral/protocol/models";
import type { RpcConnection } from "./rpc-connection.ts";
import { createWatchStore } from "./watch-store.ts";

export function createModelPreferencesStore(connection: RpcConnection) {
  return createWatchStore<
    ModelPreferences,
    { loaded: boolean; items: readonly ModelPreferences[] }
  >(connection, {
    name: "models.watch",
    initial: { loaded: false, items: [] },
    watch: (rpc) => rpc.api.models.watch(),
    toSnapshot: (items) => ({ loaded: true, items }),
  });
}
