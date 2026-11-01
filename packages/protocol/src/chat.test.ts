import { expect, test } from "vite-plus/test";
import { ChatItem, ChatStreamMessage } from "./chat.ts";

const assistant = { kind: "assistant-message", id: "a1", text: "Done", streaming: false };

test("a snapshot carries the whole timeline and the session state", () => {
  const message = ChatStreamMessage.parse({
    type: "snapshot",
    snapshot: {
      sequence: 3,
      state: {
        turn: "working",
        steering: ["use the smaller helper"],
        followUp: [],
        model: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet 4.5" },
        models: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet 4.5" }],
        reasoning: "high",
        reasoningLevels: ["low", "high"],
      },
      items: [
        { kind: "user-message", id: "u1", text: "Fix it" },
        assistant,
        { kind: "reasoning", id: "r1", text: "Think", streaming: true },
        {
          kind: "tool-call",
          id: "t1",
          name: "edit",
          arguments: '{"path":"a.ts"}',
          status: "done",
          output: "edited",
          diff: { path: "a.ts", text: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n" },
        },
        {
          kind: "user-request",
          id: "q1",
          request: "confirm",
          title: "Run the migration?",
          options: [],
          placeholder: null,
          prefill: null,
          expiresAt: 1_700_000_000_000,
          status: "pending",
        },
        { kind: "notice", id: "n1", text: "compacted" },
        { kind: "error", id: "e1", text: "The provider refused the key." },
      ],
    },
  });

  expect(message.type).toBe("snapshot");
});

test("events are distinguished by type and every item kind is accepted", () => {
  for (const kind of ["item", "delta", "state"]) {
    const event = ChatStreamMessage.parse({
      type: "event",
      sequence: 4,
      event:
        kind === "item"
          ? { type: "item", item: assistant }
          : kind === "delta"
            ? { type: "delta", itemId: "a1", text: "more" }
            : {
                type: "state",
                state: {
                  turn: "settled",
                  steering: [],
                  followUp: [],
                  model: null,
                  models: [],
                  reasoning: null,
                  reasoningLevels: [],
                },
              },
    });
    expect(event).toMatchObject({ type: "event", sequence: 4 });
  }
  // Every kind in the union is a valid item, so a driver cannot emit something the client drops.
  expect(ChatItem.options).toHaveLength(7);
});

test("a sequence must be a hole-free nonnegative integer where the stream needs one", () => {
  expect(
    ChatStreamMessage.safeParse({
      type: "event",
      sequence: 0,
      event: { type: "item", item: assistant },
    }).success,
  ).toBe(false);
  expect(
    ChatStreamMessage.safeParse({
      type: "snapshot",
      snapshot: { sequence: -1, state: {}, items: [] },
    }).success,
  ).toBe(false);
});
