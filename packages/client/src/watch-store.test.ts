import { expect, test, vi } from "vite-plus/test";
import type { ConnectionState } from "./connection-state.ts";
import type { RpcConnection } from "./rpc-connection.ts";
import { Store } from "./store.ts";
import { createWatchStore } from "./watch-store.ts";

interface Item {
  id: string;
}

interface Snapshot {
  loaded: boolean;
  items: readonly Item[];
}

/** A connection whose socket state the test drives; the watch call itself is the store option. */
function fakeConnection(state: Store<ConnectionState>): RpcConnection {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the store reads only `state`
  return { state } as unknown as RpcConnection;
}

function generator(...batches: readonly (readonly Item[])[]): AsyncIterable<readonly Item[]> {
  return (async function* () {
    for (const batch of batches) yield batch;
  })();
}

function storeWith(
  state: Store<ConnectionState>,
  watch: () => Promise<AsyncIterable<readonly Item[]>>,
) {
  return createWatchStore<Item, Snapshot>(fakeConnection(state), {
    name: "projects.watch",
    label: "project list",
    initial: { loaded: false, items: [] },
    watch,
    toSnapshot: (items) => ({ loaded: true, items }),
  });
}

test("a refused watch is a failure the store reports, and Retry starts it again", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const state = new Store<ConnectionState>({ status: "connecting" });
  const error = new Error("no such procedure");
  let attempts = 0;
  const store = storeWith(state, async () => {
    attempts += 1;
    if (attempts === 1) throw error;
    return generator([{ id: "after-retry" }]);
  });

  try {
    expect(store.getSnapshot()).toEqual({ loaded: false, items: [] });
    expect(store.failure.getSnapshot()).toBeUndefined();

    state.set({ status: "connected" });
    await vi.waitFor(() =>
      expect(store.failure.getSnapshot()).toEqual({
        name: "projects.watch",
        label: "project list",
        error,
      }),
    );
    // The first list never arrived: refused is not loaded and not empty.
    expect(store.getSnapshot()).toEqual({ loaded: false, items: [] });

    store.retry();
    await vi.waitFor(() =>
      expect(store.getSnapshot()).toEqual({ loaded: true, items: [{ id: "after-retry" }] }),
    );
    expect(store.failure.getSnapshot()).toBeUndefined();
    expect(attempts).toBe(2);
  } finally {
    store.close();
    vi.restoreAllMocks();
  }
});

test("a refusal clears when the connection returns and a list arrives", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const state = new Store<ConnectionState>({ status: "connecting" });
  let attempts = 0;
  const store = storeWith(state, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("Not Found");
    return generator([{ id: "reconnected" }]);
  });

  try {
    state.set({ status: "connected" });
    await vi.waitFor(() => expect(store.failure.getSnapshot()?.name).toBe("projects.watch"));

    state.set({ status: "disconnected" });
    state.set({ status: "connected" });
    await vi.waitFor(() =>
      expect(store.getSnapshot()).toEqual({ loaded: true, items: [{ id: "reconnected" }] }),
    );
    expect(store.failure.getSnapshot()).toBeUndefined();
    expect(attempts).toBe(2);
  } finally {
    store.close();
    vi.restoreAllMocks();
  }
});

test("a dropped socket keeps the last list and is not a refusal", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const state = new Store<ConnectionState>({ status: "connected" });
  let attempts = 0;
  let drop: ((error: Error) => void) | undefined;
  let reading = false;
  const store = storeWith(state, async () => {
    attempts += 1;
    if (attempts > 1) return generator([{ id: "after-reconnect" }]);
    return (async function* () {
      yield [{ id: "kept" }];
      reading = true;
      await new Promise<never>((_, reject) => {
        drop = reject;
      });
    })();
  });

  try {
    await vi.waitFor(() => expect(store.getSnapshot().items).toEqual([{ id: "kept" }]));
    // The socket goes away while the watch is suspended; that ends the stream, not the server.
    state.set({ status: "disconnected" });
    await vi.waitFor(() => expect(reading).toBe(true));
    drop?.(new Error("socket closed"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(store.failure.getSnapshot()).toBeUndefined();
    expect(store.getSnapshot()).toEqual({ loaded: true, items: [{ id: "kept" }] });

    state.set({ status: "connected" });
    await vi.waitFor(() =>
      expect(store.getSnapshot()).toEqual({ loaded: true, items: [{ id: "after-reconnect" }] }),
    );
    expect(attempts).toBe(2);
  } finally {
    store.close();
    vi.restoreAllMocks();
  }
});
