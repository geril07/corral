import { defaultModelPolicy, type ModelPreferences } from "@corral/protocol/models";
import { expect, test, vi } from "vite-plus/test";
import type { ConnectionState } from "./connection-state.ts";
import { createModelPreferencesStore } from "./model-preferences-store.ts";
import type { RpcConnection } from "./rpc-connection.ts";
import { Store } from "./store.ts";

/** The store reads only the socket state and `models.watch`; the test drives both. */
function fakeConnection(
  state: Store<ConnectionState>,
  watch: () => Promise<AsyncIterable<readonly ModelPreferences[]>>,
): RpcConnection {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only `state` and `models.watch` are read
  return { state, api: { models: { watch } } } as unknown as RpcConnection;
}

test("a refused model preferences watch is exposed, keeps the snapshot unloaded, and Retry starts it again", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const state = new Store<ConnectionState>({
    status: "connecting",
    attempt: 1,
    startedAt: Date.now(),
  });
  const error = new Error("no such procedure");
  const saved: ModelPreferences = {
    scope: { kind: "pi", profileId: null },
    revision: 7,
    policy: defaultModelPolicy(),
  };
  let attempts = 0;
  const store = createModelPreferencesStore(
    fakeConnection(state, async () => {
      attempts += 1;
      if (attempts === 1) throw error;
      return (async function* () {
        yield [saved];
      })();
    }),
  );

  try {
    expect(store.getSnapshot()).toEqual({ loaded: false, items: [] });
    expect(store.failure.getSnapshot()).toBeUndefined();

    state.set({ status: "connected" });
    await vi.waitFor(() =>
      expect(store.failure.getSnapshot()).toEqual({
        name: "models.watch",
        label: "model preferences",
        error,
      }),
    );
    // Refused before the first item: unloaded, never an empty list.
    expect(store.getSnapshot()).toEqual({ loaded: false, items: [] });

    store.retry();
    await vi.waitFor(() => expect(store.getSnapshot()).toEqual({ loaded: true, items: [saved] }));
    expect(store.failure.getSnapshot()).toBeUndefined();
    expect(attempts).toBe(2);
  } finally {
    store.close();
    vi.restoreAllMocks();
  }
});
