import type { ChatDriverCapabilities } from "@corral/protocol/chat";
import { expect, test, vi } from "vite-plus/test";
import {
  chatDriverFor,
  createChatCapabilitiesStore,
  type ChatCapabilitiesSource,
  type ChatCapabilitiesStore,
} from "./chat-capabilities-store.ts";
import type { ConnectionState } from "./connection-state.ts";
import { Store } from "./store.ts";

/** One driver's record, as `chat.capabilities` reports it (protocol 10). */
function driver(kind: "pi" | "claude"): ChatDriverCapabilities {
  return {
    kind,
    steer: kind === "pi",
    followUp: kind === "pi",
    approvals: true,
    modelSwitch: kind === "pi",
    reasoningLevels: kind === "pi",
    terminalView: "handoff-only",
  };
}

const PI = driver("pi");
const CLAUDE = driver("claude");

/** A source whose socket state the test drives and whose one call it counts. */
function fakeSource(capabilities: () => Promise<{ drivers: ChatDriverCapabilities[] }>): {
  source: ChatCapabilitiesSource;
  state: Store<ConnectionState>;
  calls: () => number;
} {
  const state = new Store<ConnectionState>({
    status: "connecting",
    attempt: 1,
    startedAt: Date.now(),
  });
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
  const { source, state, calls } = fakeSource(async () => ({ drivers: [PI] }));
  const store: ChatCapabilitiesStore = createChatCapabilitiesStore(source);
  // Connecting, not connected yet: nothing is asked and nothing is claimed.
  expect(store.getSnapshot()).toEqual({ loaded: false, drivers: [] });

  // Two connected notifications for one connection ask once.
  state.set({ status: "connected" });
  state.set({ status: "connected" });
  await vi.waitFor(() => expect(store.getSnapshot()).toEqual({ loaded: true, drivers: [PI] }));
  expect(calls()).toBe(1);

  // A reconnect asks the new server: within one protocol version the list changes with a driver.
  state.set({ status: "disconnected", attempt: 1, startedAt: Date.now() });
  // The answer already received is kept, so a reconnecting client keeps the offer it showed.
  expect(store.getSnapshot()).toEqual({ loaded: true, drivers: [PI] });
  state.set({ status: "connected" });
  await vi.waitFor(() => expect(calls()).toBe(2));
  store.close();
});

test("a failed question is asked again at the next connection, and a late answer is ignored", async () => {
  let fail = true;
  let settle: ((answer: { drivers: ChatDriverCapabilities[] }) => void) | undefined;
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
  state.set({ status: "disconnected", attempt: 1, startedAt: Date.now() });
  state.set({ status: "connected" });
  await vi.waitFor(() => expect(calls()).toBe(2));
  state.set({ status: "disconnected", attempt: 1, startedAt: Date.now() });
  settle?.({ drivers: [CLAUDE] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(store.getSnapshot()).toEqual({ loaded: false, drivers: [] });

  // The connection that is current asks again and is what the store reports.
  state.set({ status: "connected" });
  await vi.waitFor(() => expect(calls()).toBe(3));
  settle?.({ drivers: [PI] });
  await vi.waitFor(() => expect(store.getSnapshot()).toEqual({ loaded: true, drivers: [PI] }));
  store.close();
});

test("a driver is found by its agent kind, and an agent without one is not claimed", () => {
  expect(chatDriverFor([PI, CLAUDE], "claude")).toEqual(CLAUDE);
  expect(chatDriverFor([PI], "claude")).toBeUndefined();
});
