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
