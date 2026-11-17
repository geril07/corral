import { expect, test } from "vite-plus/test";
import { OpenCodeProjection } from "./opencode-projection.ts";
import { ChatTimeline } from "./timeline.ts";

function projection() {
  const timeline = new ChatTimeline(0);
  return {
    timeline,
    projection: new OpenCodeProjection(timeline, { now: () => 0, dialogTimeoutMs: 1000 }),
  };
}

function delta(messageId: string, text: string, ordinal = 0) {
  return {
    type: "session.text.delta",
    data: { sessionID: "ses_test", assistantMessageID: messageId, ordinal, delta: text },
  };
}

function textOf(timeline: ChatTimeline, id: string): string {
  const item = timeline.item(id);
  return item?.kind === "assistant-message" ? item.text : "";
}

test("a delta that repeats the previous tail is appended, not deduplicated", () => {
  const { timeline, projection: view } = projection();
  for (const piece of ["coffe", "e"]) view.applyEvent(delta("msg_one", piece));
  expect(textOf(timeline, "text:msg_one:0")).toBe("coffee");

  for (const piece of ["ha", "ha"]) view.applyEvent(delta("msg_two", piece));
  expect(textOf(timeline, "text:msg_two:0")).toBe("haha");

  // A blank line is a delta too, and a delta equal to the whole previous text is not a replay.
  for (const piece of ["line", "\n\n", "line"]) view.applyEvent(delta("msg_three", piece));
  expect(textOf(timeline, "text:msg_three:0")).toBe("line\n\nline");
});

test("only a replay is measured against the hydrated text", () => {
  const { timeline, projection: view } = projection();
  view.loadHistory([
    {
      id: "msg_hydrated",
      type: "assistant",
      content: [{ type: "text", text: "Hello world" }],
      model: { id: "stub", providerID: "stub" },
    },
  ]);
  // The event that arrived during the hydrate: already covered by the rebuilt text.
  view.applyEvent(delta("msg_hydrated", " world"), { replay: true });
  expect(textOf(timeline, "text:msg_hydrated:0")).toBe("Hello world");
  // A live delta that happens to repeat the tail is new text.
  view.applyEvent(delta("msg_hydrated", " world"));
  expect(textOf(timeline, "text:msg_hydrated:0")).toBe("Hello world world");
});

test("message tokens become the context reading against the catalogued model window", () => {
  const { timeline, projection: view } = projection();
  view.setModelWindows(new Map([["stub/stub-1", 200_000]]));
  view.loadHistory([
    {
      id: "msg_ctx_1",
      type: "assistant",
      content: [{ type: "text", text: "first" }],
      model: { id: "stub-1", providerID: "stub" },
      tokens: {
        input: 1_000,
        output: 500,
        reasoning: 0,
        cache: { read: 40_000, write: 100 },
      },
    },
    {
      id: "msg_ctx_2",
      type: "assistant",
      content: [{ type: "text", text: "second" }],
      model: { id: "stub-1", providerID: "stub" },
      tokens: { input: 2_000, output: 600, reasoning: 0, cache: { read: 45_000, write: 0 } },
    },
  ]);
  expect(timeline.state.context).toEqual({ usedTokens: 47_600, maxTokens: 200_000 });

  // A live step reports the same figures, and a model the catalog does not list keeps the count
  // without a window instead of inventing one.
  view.applyEvent({
    type: "session.step.ended",
    data: {
      sessionID: "ses_test",
      assistantMessageID: "msg_ctx_3",
      tokens: { input: 2_100, output: 700, reasoning: 0, cache: { read: 45_000, write: 0 } },
    },
  });
  expect(timeline.state.context).toEqual({ usedTokens: 47_800, maxTokens: 200_000 });

  // A model the catalog does not list keeps the count without a window instead of inventing one.
  view.loadHistory([
    {
      id: "msg_ctx_4",
      type: "assistant",
      content: [],
      model: { id: "other", providerID: "stub" },
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  ]);
  expect(timeline.state.context).toEqual({ usedTokens: 15, maxTokens: null });
});
