import type {
  ChatAssistantMessage,
  ChatItem,
  ChatReasoning,
  ChatSessionState,
  ChatStreamMessage,
  ChatToolCall,
} from "@corral/protocol/chat";
import type { ChatWatchInput } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { createChatStore, type ChatSource } from "./chat-store.ts";
import type { ConnectionState } from "./connection-state.ts";
import { Store } from "./store.ts";

const SESSION = "session-1";

const idle: ChatSessionState = {
  turn: "idle",
  steering: [],
  followUp: [],
  model: null,
  models: [],
  reasoning: null,
  reasoningLevels: [],
};

const user: ChatItem = { kind: "user-message", id: "u1", text: "Fix the flaky test" };

function assistant(text: string, streaming: boolean): ChatAssistantMessage {
  return { kind: "assistant-message", id: "a1", text, streaming };
}

function reasoning(text: string, streaming: boolean): ChatReasoning {
  return { kind: "reasoning", id: "r1", text, streaming };
}

const tool: ChatToolCall = {
  kind: "tool-call",
  id: "t1",
  name: "bash",
  arguments: '{"command":"pnpm test"}',
  status: "running",
  output: null,
  diff: null,
};

/** A watch whose messages the test pushes: one stream per `chat.watch` call. */
class FakeWatch implements AsyncIterable<ChatStreamMessage> {
  readonly #messages: ChatStreamMessage[] = [];
  #notify: (() => void) | undefined;
  #ended = false;
  /** Messages the store pulled; the signal a test waits on after `close()`. */
  pulled = 0;

  push(...messages: ChatStreamMessage[]): void {
    this.#messages.push(...messages);
    this.#notify?.();
  }

  end(): void {
    this.#ended = true;
    this.#notify?.();
  }

  [Symbol.asyncIterator](): AsyncIterator<ChatStreamMessage> {
    return {
      next: async (): Promise<IteratorResult<ChatStreamMessage>> => {
        for (;;) {
          const message = this.#messages.shift();
          if (message !== undefined) {
            this.pulled += 1;
            return { done: false, value: message };
          }
          if (this.#ended) return { done: true, value: undefined };
          // One message at a time, in order: a fake stream, not a batch to run in parallel.
          // oxlint-disable-next-line eslint/no-await-in-loop
          await new Promise<void>((resolve) => {
            this.#notify = resolve;
          });
          this.#notify = undefined;
        }
      },
      return: async (): Promise<IteratorResult<ChatStreamMessage>> => {
        this.end();
        return { done: true, value: undefined };
      },
    };
  }
}

/**
 * A store on a fake stream: the server half of `chat.watch` arrives in B1, so these tests drive
 * its messages directly and inspect what the store asks for on each (re)connection. `reject`
 * makes every watch call fail, which is how a refusal (`CHAT_UNAVAILABLE`) is exercised.
 */
function fakeChat(options: { reject?: Error; refusals?: number } = {}) {
  const state = new Store<ConnectionState>({ status: "connected" });
  const calls: ChatWatchInput[] = [];
  const streams: FakeWatch[] = [];
  let refusals = options.reject ? (options.refusals ?? Number.POSITIVE_INFINITY) : 0;
  const source: ChatSource = {
    state,
    watch: (input) => {
      calls.push(input);
      if (options.reject && refusals > 0) {
        refusals -= 1;
        return Promise.reject(options.reject);
      }
      const stream = new FakeWatch();
      streams.push(stream);
      return Promise.resolve(stream);
    },
  };
  const store = createChatStore(source, SESSION);
  const stop = () => {
    store.close();
    for (const stream of streams) stream.end();
  };
  return { state, calls, streams, store, stop };
}

const waitFor = (assertion: () => void) => vi.waitFor(assertion, { timeout: 2_000, interval: 10 });

const snapshot = (
  sequence: number,
  state: ChatSessionState,
  items: ChatItem[],
): ChatStreamMessage => ({
  type: "snapshot",
  snapshot: { sequence, state, items },
});

const event = (
  sequence: number,
  value: Extract<ChatStreamMessage, { type: "event" }>["event"],
): ChatStreamMessage => ({
  type: "event",
  sequence,
  event: value,
});

test("a snapshot fills the store, then events apply by sequence and item id", async () => {
  const chat = fakeChat();
  try {
    await waitFor(() => expect(chat.calls).toHaveLength(1));
    expect(chat.calls[0]).toEqual({ sessionId: SESSION });
    expect(chat.store.getSnapshot().loaded).toBe(false);

    chat.streams[0]!.push(snapshot(1, { ...idle, turn: "working" }, [user, assistant("", true)]));
    await waitFor(() => expect(chat.store.getSnapshot().loaded).toBe(true));

    chat.streams[0]!.push(
      event(2, { type: "delta", itemId: "a1", text: "Look" }),
      event(3, { type: "item", item: tool }),
      event(4, { type: "item", item: { ...tool, status: "done", output: "ok" } }),
      event(5, { type: "state", state: { ...idle, turn: "settled" } }),
    );

    await waitFor(() => {
      const state = chat.store.getSnapshot();
      expect(state.sequence).toBe(5);
      expect(state.items).toEqual([
        user,
        assistant("Look", true),
        { ...tool, status: "done", output: "ok" },
      ]);
      expect(state.state.turn).toBe("settled");
    });
  } finally {
    chat.stop();
  }
});

test("streamed assistant and reasoning text is assembled from deltas", async () => {
  const chat = fakeChat();
  try {
    await waitFor(() => expect(chat.calls).toHaveLength(1));
    chat.streams[0]!.push(
      snapshot(1, { ...idle, turn: "working" }, [assistant("", true), reasoning("", true)]),
    );
    await waitFor(() => expect(chat.store.getSnapshot().loaded).toBe(true));

    chat.streams[0]!.push(
      event(2, { type: "delta", itemId: "a1", text: "Hel" }),
      event(3, { type: "delta", itemId: "a1", text: "lo" }),
      event(4, { type: "delta", itemId: "r1", text: "Think" }),
      // The agent's final text is authoritative: it replaces the assembled text and ends streaming.
      event(5, { type: "item", item: assistant("Hello", false) }),
    );

    await waitFor(() => {
      expect(chat.store.getSnapshot().items).toEqual([
        assistant("Hello", false),
        reasoning("Think", true),
      ]);
    });
  } finally {
    chat.stop();
  }
});

test("a reconnect asks for the events after the last sequence and applies them", async () => {
  const chat = fakeChat();
  try {
    await waitFor(() => expect(chat.calls).toHaveLength(1));
    chat.streams[0]!.push(snapshot(5, idle, [user]));
    await waitFor(() => expect(chat.store.getSnapshot().sequence).toBe(5));

    chat.state.set({ status: "disconnected" });
    chat.streams[0]!.end();
    chat.state.set({ status: "connected" });

    await waitFor(() => expect(chat.calls).toHaveLength(2));
    expect(chat.calls[1]).toEqual({ sessionId: SESSION, after: 5 });

    // What the server recorded while this client was away: no snapshot, just the missing events.
    chat.streams[1]!.push(event(6, { type: "item", item: assistant("done", false) }));

    await waitFor(() => {
      const state = chat.store.getSnapshot();
      expect(state.sequence).toBe(6);
      expect(state.items).toEqual([user, assistant("done", false)]);
    });
  } finally {
    chat.stop();
  }
});

test("a sequence gap makes the store ask for a snapshot and rebuild the timeline", async () => {
  const chat = fakeChat();
  try {
    await waitFor(() => expect(chat.calls).toHaveLength(1));
    chat.streams[0]!.push(snapshot(5, idle, [user]));
    await waitFor(() => expect(chat.store.getSnapshot().sequence).toBe(5));

    chat.state.set({ status: "disconnected" });
    chat.streams[0]!.end();
    chat.state.set({ status: "connected" });
    await waitFor(() => expect(chat.calls).toHaveLength(2));
    expect(chat.calls[1]).toEqual({ sessionId: SESSION, after: 5 });

    // The server no longer has 6 and 7, but this client asked for 6: the stream jumps to 8.
    chat.streams[1]!.push(event(8, { type: "item", item: assistant("late", false) }));

    await waitFor(() => expect(chat.calls).toHaveLength(3));
    // Without `after`, the server must start with a snapshot instead of replaying.
    expect(chat.calls[2]).toEqual({ sessionId: SESSION });

    chat.streams[2]!.push(snapshot(9, { ...idle, turn: "settled" }, [user, tool]));
    await waitFor(() => {
      const state = chat.store.getSnapshot();
      expect(state.sequence).toBe(9);
      expect(state.items).toEqual([user, tool]);
    });

    // The rebuilt timeline keeps growing from the snapshot's sequence.
    chat.streams[2]!.push(event(10, { type: "item", item: assistant("after", false) }));
    await waitFor(() => {
      const state = chat.store.getSnapshot();
      expect(state.sequence).toBe(10);
      expect(state.items).toHaveLength(3);
    });
  } finally {
    chat.stop();
  }
});

test("an event before any snapshot is treated as a gap and asks for one", async () => {
  const chat = fakeChat();
  try {
    await waitFor(() => expect(chat.calls).toHaveLength(1));
    chat.streams[0]!.push(event(1, { type: "item", item: user }));

    await waitFor(() => expect(chat.calls).toHaveLength(2));
    expect(chat.calls[1]).toEqual({ sessionId: SESSION });

    chat.streams[1]!.push(snapshot(2, idle, [user]));
    await waitFor(() => {
      expect(chat.store.getSnapshot().loaded).toBe(true);
      expect(chat.store.getSnapshot().sequence).toBe(2);
    });
  } finally {
    chat.stop();
  }
});

test("a clean end of the stream watches again once instead of freezing", async () => {
  const chat = fakeChat();
  try {
    await waitFor(() => expect(chat.calls).toHaveLength(1));
    chat.streams[0]!.push(snapshot(5, idle, [user]));
    await waitFor(() => expect(chat.store.getSnapshot().sequence).toBe(5));

    // The server may end a watch; that is not the end of the chat.
    chat.streams[0]!.end();
    await waitFor(() => expect(chat.calls).toHaveLength(2));
    expect(chat.calls[1]).toEqual({ sessionId: SESSION, after: 5 });

    chat.streams[1]!.push(event(6, { type: "item", item: assistant("still here", false) }));
    await waitFor(() => expect(chat.store.getSnapshot().sequence).toBe(6));
    expect(chat.store.getSnapshot().failure).toBeNull();

    // The retry ended too: record why and wait for the next connection change, not another call.
    chat.streams[1]!.end();
    await waitFor(() => expect(chat.store.getSnapshot().failure?.code).toBe("CHAT_STREAM_ENDED"));
    expect(chat.calls).toHaveLength(2);
  } finally {
    chat.stop();
  }
});

test("a refused watch is reported on the store instead of disappearing", async () => {
  const refusal = Object.assign(new Error("This server has no chat driver for any session yet."), {
    code: "CHAT_UNAVAILABLE",
  });
  const chat = fakeChat({ reject: refusal });
  try {
    // One refusal is retried immediately; after the second, the failure stays on the store.
    await waitFor(() =>
      expect(chat.store.getSnapshot().failure).toEqual({
        code: "CHAT_UNAVAILABLE",
        message: refusal.message,
      }),
    );
    expect(chat.calls).toHaveLength(2);
  } finally {
    chat.stop();
  }
});

test("a retry that is accepted clears the refusal before any message arrives", async () => {
  const refusal = Object.assign(new Error("This server has no chat driver for any session yet."), {
    code: "CHAT_UNAVAILABLE",
  });
  const chat = fakeChat({ reject: refusal, refusals: 1 });
  try {
    // The first call is refused, the immediate retry is accepted. No message has been applied yet,
    // so only the accepted call can have cleared the refusal.
    await waitFor(() => expect(chat.streams).toHaveLength(1));
    expect(chat.calls).toHaveLength(2);
    expect(chat.store.getSnapshot().failure).toBeNull();
    expect(chat.store.getSnapshot().loaded).toBe(false);

    chat.streams[0]!.push(snapshot(1, idle, [user]));
    await waitFor(() => expect(chat.store.getSnapshot().loaded).toBe(true));
  } finally {
    chat.stop();
  }
});

test("close stops the watch and no message is applied afterwards", async () => {
  const chat = fakeChat();
  try {
    await waitFor(() => expect(chat.calls).toHaveLength(1));
    chat.streams[0]!.push(snapshot(5, idle, [user]));
    await waitFor(() => expect(chat.store.getSnapshot().sequence).toBe(5));

    chat.store.close();
    const stream = chat.streams[0]!;
    const pulled = stream.pulled;
    stream.push(event(6, { type: "item", item: assistant("late", false) }));

    // The store pulls the message and then drops it because the store is closed; no retry either.
    await waitFor(() => expect(stream.pulled).toBe(pulled + 1));
    expect(chat.store.getSnapshot().sequence).toBe(5);
    expect(chat.calls).toHaveLength(1);
  } finally {
    chat.stop();
  }
});
