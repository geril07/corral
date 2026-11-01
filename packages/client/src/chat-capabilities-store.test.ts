import { expect, test, vi } from "vite-plus/test";
import {
  createChatCapabilitiesStore,
  type ChatCapabilitiesSource,
  type ChatCapabilitiesStore,
} from "./chat-capabilities-store.ts";
import type { ConnectionState } from "./connection-state.ts";
import { Store } from "./store.ts";

/** A source whose socket state the test drives and whose one call it counts. */
function fakeSource(capabilities: () => Promise<{ drivers: ("pi" | "claude")[] }>): {
  source: ChatCapabilitiesSource;
  state: Store<ConnectionState>;
  calls: () => number;
} {
  const state = new Store<ConnectionState>({ status: "connecting" });
  let calls = 0;
  return {
    source: {
      state,
      capabilities: () => {
        calls += 1;
        return capabilities();
      },
    },
    state,
    calls: () => calls,
  };
}

test("the drivers are asked for once per connection and kept while the socket is down", async () => {
  const { source, state, calls } = fakeSource(async () => ({ drivers: ["pi"] }));
  const store: ChatCapabilitiesStore = createChatCapabilitiesStore(source);
  // Connecting, not connected yet: nothing is asked and nothing is claimed.
  expect(store.getSnapshot()).toEqual({ loaded: false, drivers: [] });

  // Two connected notifications for one connection ask once.
  state.set({ status: "connected" });
  state.set({ status: "connected" });
  await vi.waitFor(() => expect(store.getSnapshot()).toEqual({ loaded: true, drivers: ["pi"] }));
  expect(calls()).toBe(1);

  // A reconnect asks the new server: within protocol 9 the list changes when a driver lands.
  state.set({ status: "disconnected" });
  // The answer already received is kept, so a reconnecting client keeps the offer it showed.
  expect(store.getSnapshot()).toEqual({ loaded: true, drivers: ["pi"] });
  state.set({ status: "connected" });
  await vi.waitFor(() => expect(calls()).toBe(2));
  store.close();
});

test("a failed question is asked again at the next connection, and a late answer is ignored", async () => {
  let fail = true;
  let settle: ((answer: { drivers: ("pi" | "claude")[] }) => void) | undefined;
  const { source, state, calls } = fakeSource(() => {
    if (fail) return Promise.reject(new Error("the server is not there"));
    return new Promise((resolve) => (settle = resolve));
  });
  const store = createChatCapabilitiesStore(source);

  state.set({ status: "connected" });
  await vi.waitFor(() => expect(calls()).toBe(1));
  expect(store.getSnapshot()).toEqual({ loaded: false, drivers: [] });

  // The socket drops while the second question is in flight; its answer belongs to a dead socket.
  fail = false;
  state.set({ status: "disconnected" });
  state.set({ status: "connected" });
  await vi.waitFor(() => expect(calls()).toBe(2));
  state.set({ status: "disconnected" });
  settle?.({ drivers: ["claude"] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(store.getSnapshot()).toEqual({ loaded: false, drivers: [] });

  // The connection that is current asks again and is what the store reports.
  state.set({ status: "connected" });
  await vi.waitFor(() => expect(calls()).toBe(3));
  settle?.({ drivers: ["pi"] });
  await vi.waitFor(() => expect(store.getSnapshot()).toEqual({ loaded: true, drivers: ["pi"] }));
  store.close();
});
