import type {
  ChatEvent,
  ChatItem,
  ChatSessionState,
  ChatStreamMessage,
} from "@corral/protocol/chat";
import { createChatStore, type ChatSource, type ChatStore } from "@corral/client/chat-store";
import type { ConnectionState } from "@corral/client/connection-state";
import { Store } from "@corral/client/store";

/** The B0 session state a fresh chat starts with, for fixtures that only need a turn. */
export const IDLE_CHAT: ChatSessionState = {
  turn: "idle",
  steering: [],
  followUp: [],
  model: null,
  models: [],
  reasoning: null,
  reasoningLevels: [],
};

export function workingChat(overrides: Partial<ChatSessionState> = {}): ChatSessionState {
  return { ...IDLE_CHAT, turn: "working", ...overrides };
}

function event(sequence: number, payload: ChatEvent): ChatStreamMessage {
  return { type: "event", sequence, event: payload };
}

/** Wraps events over a snapshot at sequence 0; the sequence check is how tests catch a bad fixture. */
export function recorded(
  events: readonly ChatEvent[],
  snapshot: { state?: ChatSessionState; items?: ChatItem[] } = {},
): ChatStreamMessage[] {
  return [
    {
      type: "snapshot",
      snapshot: {
        sequence: 0,
        state: snapshot.state ?? IDLE_CHAT,
        items: snapshot.items ?? [],
      },
    },
    ...events.map((each, index) => event(index + 1, each)),
  ];
}

const userMessage: ChatItem = {
  kind: "user-message",
  id: "u1",
  text: "The auth test is flaky on CI. Fix it.",
};

const reasoningText = "The test waits a fixed 50 ms for the cookie, then races the assertion.";

const readCall: ChatItem = {
  kind: "tool-call",
  id: "t1",
  name: "read",
  arguments: '{"path":"src/auth.test.ts"}',
  status: "done",
  output:
    'import { expect, it } from "vitest";\n\nit("restores the session", async () => {\n  await new Promise((resolve) => setTimeout(resolve, 50));\n  expect(cookie()).toBeDefined();\n});',
  diff: null,
};

const bashCall: ChatItem = {
  kind: "tool-call",
  id: "t2",
  name: "bash",
  arguments: '{"command":"pnpm vitest run src/auth.test.ts"}',
  status: "done",
  output: "1 failed | 11 passed (12)",
  diff: null,
};

const PATCH = [
  "--- src/auth.test.ts",
  "+++ src/auth.test.ts",
  "@@ -1,5 +1,5 @@",
  ' it("restores the session", async () => {',
  "-  await new Promise((resolve) => setTimeout(resolve, 50));",
  "+  await vi.waitFor(() => expect(cookie()).toBeDefined());",
  "   expect(session().userId).toBe(user.id);",
  " });",
  "",
].join("\n");

const editCall: ChatItem = {
  kind: "tool-call",
  id: "t3",
  name: "edit",
  arguments:
    '{"path":"src/auth.test.ts","edits":[{"oldText":"setTimeout(resolve, 50)","newText":"vi.waitFor(...)"}]}',
  status: "done",
  output: "Successfully replaced 1 block(s) in src/auth.test.ts.",
  diff: { path: "src/auth.test.ts", text: PATCH },
};

const finalAnswer: ChatItem = {
  kind: "assistant-message",
  id: "a1",
  streaming: false,
  text: [
    "Waits on the condition instead of a fixed delay.",
    "",
    "```ts",
    "await vi.waitFor(() => expect(cookie()).toBeDefined());",
    "```",
    "",
    "1. The cookie write is asynchronous.",
    "2. The timeout was the only race.",
  ].join("\n"),
};

const request: ChatItem = {
  kind: "user-request",
  id: "q1",
  request: "select",
  title: "Which suite should I run next?",
  body: "The auth test passes now; two other suites were red before the change.",
  options: [
    { value: "auth", label: "auth.test.ts" },
    { value: "session", label: "session.test.ts", description: "failed before this change" },
    { value: "all", label: "The whole suite" },
  ],
  placeholder: null,
  prefill: null,
  expiresAt: null,
  status: "pending",
};

/**
 * A recorded chat: user message, reasoning, a streamed answer, three finished tool calls (one
 * with a diff), a notice, an error and a pending request. B3 renders from this instead of a live
 * pi driver (goal D4); the diff is pi's `details.patch`, which is what B1 will map to `ChatDiff`.
 */
export const RECORDED_CHAT: ChatStreamMessage[] = recorded([
  { type: "item", item: userMessage },
  { type: "state", state: workingChat() },
  {
    type: "item",
    item: { kind: "reasoning", id: "r1", text: reasoningText, streaming: true },
  },
  {
    type: "delta",
    itemId: "r1",
    text: "\nThe timeout is the only race.",
  },
  {
    type: "item",
    item: {
      kind: "reasoning",
      id: "r1",
      text: `${reasoningText}\nThe timeout is the only race.`,
      streaming: false,
    },
  },
  {
    type: "item",
    item: {
      kind: "assistant-message",
      id: "a1",
      text: "I'll read the test and the auth module.",
      streaming: true,
    },
  },
  { type: "delta", itemId: "a1", text: "\n\nThen I'll replace the delay." },
  { type: "item", item: readCall },
  { type: "item", item: bashCall },
  { type: "item", item: editCall },
  { type: "item", item: finalAnswer },
  { type: "item", item: { kind: "notice", id: "n1", text: "Compacted 12 earlier messages." } },
  { type: "item", item: { kind: "error", id: "e1", text: "The retry was refused once." } },
  { type: "state", state: workingChat({ model: null }) },
  { type: "item", item: request },
]);

/** A seq after the recorded stream, so a test can append its own events without a hole. */
export const RECORDED_SEQUENCE = RECORDED_CHAT.length - 1;

/**
 * A `chat.watch` a test drives: it yields the messages it is given and waits for more, so the real
 * store applies the real sequencing rules. `push` appends; `close` ends the watch.
 */
class ScriptedChatSource implements ChatSource {
  readonly state = new Store<ConnectionState>({ status: "connected" });
  readonly #queue: ChatStreamMessage[];
  #wake: (() => void) | undefined;
  #closed = false;

  constructor(initial: readonly ChatStreamMessage[]) {
    this.#queue = [...initial];
  }

  watch(): Promise<AsyncIterable<ChatStreamMessage>> {
    return Promise.resolve(this.#iterate());
  }

  async *#iterate(): AsyncIterable<ChatStreamMessage> {
    while (!this.#closed) {
      const next = this.#queue.shift();
      if (next === undefined) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the watch waits for the next message
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
        this.#wake = undefined;
        continue;
      }
      yield next;
    }
  }

  push(...messages: ChatStreamMessage[]): void {
    this.#queue.push(...messages);
    this.#wake?.();
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
  }
}

export interface ScriptedChat {
  source: ScriptedChatSource;
  store: ChatStore;
  push: (...messages: ChatStreamMessage[]) => void;
  close: () => void;
}

/** The real B0 store over a scripted watch; no server and no driver. */
export function scriptedChat(messages: readonly ChatStreamMessage[]): ScriptedChat {
  const source = new ScriptedChatSource(messages);
  const store = createChatStore(source, "session-chat");
  return {
    source,
    store,
    push: (...next) => source.push(...next),
    close: () => {
      source.close();
      store.close();
    },
  };
}

/** A transcript big enough to measure virtualization; the last item is a streaming answer. */
export function longChat(count: number): ChatStreamMessage[] {
  const items: ChatItem[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `long-${index}`;
    switch (index % 5) {
      case 0:
        items.push({ kind: "user-message", id, text: `Message ${index}: please keep going.` });
        break;
      case 1:
        items.push({
          kind: "assistant-message",
          id,
          streaming: false,
          text: [
            `Answer ${index}. The quick brown fox jumps over the lazy dog, twice, so the row is a realistic width.`,
            "",
            "```ts",
            `const value${index} = ${index};`,
            "```",
          ].join("\n"),
        });
        break;
      case 2:
        items.push({
          kind: "tool-call",
          id,
          name: "read",
          arguments: `{"path":"src/file-${index}.ts"}`,
          status: "done",
          output: `contents of file ${index}`,
          diff: null,
        });
        break;
      case 3:
        items.push({
          kind: "reasoning",
          id,
          text: `Thinking about step ${index}.`,
          streaming: false,
        });
        break;
      default:
        items.push({
          kind: "assistant-message",
          id,
          streaming: false,
          text: `Short answer ${index}.`,
        });
    }
  }
  const last = items[count - 1];
  if (last?.kind === "assistant-message") items[count - 1] = { ...last, streaming: true };
  return recorded([], { state: workingChat(), items });
}
