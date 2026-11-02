import type { ChatItem, ChatSnapshot } from "@corral/protocol/chat";
import { expect, test } from "vite-plus/test";
import { CodexProjection } from "./codex-projection.ts";
import { ChatTimeline } from "./timeline.ts";

function projection(): { projection: CodexProjection; timeline: ChatTimeline } {
  const timeline = new ChatTimeline(0);
  return {
    timeline,
    projection: new CodexProjection(timeline, { now: () => 1_000, dialogTimeoutMs: 500 }),
  };
}

function items(timeline: ChatTimeline): ChatItem[] {
  return timeline.snapshot().items;
}

function snapshot(timeline: ChatTimeline): ChatSnapshot {
  return timeline.snapshot();
}

test("a file change keeps the unified diff it carries, and a turn diff covers one without", () => {
  const { projection: project, timeline } = projection();
  project.apply("turn/started", { turn: { id: "turn-1", status: "inProgress" } });
  project.apply("turn/diff/updated", { diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n" });
  project.apply("item/completed", {
    item: {
      id: "file-1",
      type: "fileChange",
      status: "completed",
      changes: [{ path: "src/x.ts", kind: "update", diff: "--- a/src/x.ts\n+++ b/src/x.ts\n" }],
    },
  });
  project.apply("item/completed", {
    item: { id: "file-2", type: "fileChange", status: "completed", changes: [] },
  });
  const diffs = items(timeline)
    .filter((item): item is Extract<ChatItem, { kind: "tool-call" }> => item.kind === "tool-call")
    .map((item) => item.diff);
  expect(diffs[0]).toEqual({ path: "src/x.ts", text: "--- a/src/x.ts\n+++ b/src/x.ts\n" });
  expect(diffs[1]?.text).toContain("@@ -1 +1 @@");
});

test("reasoning deltas join one item, and a completed item replaces the streamed text", () => {
  const { projection: project, timeline } = projection();
  project.apply("turn/started", { turn: { id: "turn-1", status: "inProgress" } });
  project.apply("item/reasoning/summaryTextDelta", { itemId: "rs-1", delta: "thinking " });
  project.apply("item/reasoning/textDelta", { itemId: "rs-1", delta: "harder" });
  let reasoning = items(timeline).find((item) => item.kind === "reasoning");
  expect(reasoning).toMatchObject({ text: "thinking harder", streaming: true });
  project.apply("item/completed", {
    item: { id: "rs-1", type: "reasoning", summary: ["the summary"], content: [] },
  });
  reasoning = items(timeline).find((item) => item.kind === "reasoning");
  expect(reasoning).toMatchObject({ text: "the summary", streaming: false });
});

test("an approval is a select request with the decisions the server accepts; resolving it elsewhere answers it", () => {
  const { projection: project, timeline } = projection();
  project.apply("turn/started", { turn: { id: "turn-1", status: "inProgress" } });
  const actions = project.requestApproval("7", "item/commandExecution/requestApproval", {
    kind: "command",
    threadId: "thr-1",
    turnId: "turn-1",
    itemId: "cmd-1",
    command: "npm test",
    cwd: "/tmp/app",
    reason: "needs the network",
  });
  expect(actions.map((action) => action.type)).toEqual(["request-opened", "status"]);
  const request = items(timeline).find((item) => item.kind === "user-request");
  expect(request).toMatchObject({
    request: "select",
    title: "Run this command?",
    body: "npm test\n\nneeds the network\n\n/tmp/app",
    status: "pending",
    expiresAt: 1_500,
  });
  expect(request?.kind === "user-request" && request.options.map((option) => option.value)).toEqual(
    ["accept", "acceptForSession", "decline", "cancel"],
  );
  // The terminal answered it: the server says so, and the chat's item is answered, not pending.
  expect(project.apply("serverRequest/resolved", { requestId: 7 })).toEqual([
    { type: "request-closed", itemId: "codex-request:7" },
  ]);
  expect(project.request("codex-request:7")).toBeUndefined();
  expect(items(timeline).find((item) => item.kind === "user-request")?.status).toBe("answered");
});

test("a rebuilt transcript maps history items and ends in the last turn's state", () => {
  const { projection: project, timeline } = projection();
  const actions = project.loadHistory([
    {
      id: "turn-1",
      status: "completed",
      items: [
        {
          id: "u-1",
          type: "userMessage",
          clientId: "user:ours",
          content: [{ type: "text", text: "hi" }],
        },
        { id: "a-1", type: "agentMessage", text: "hello", phase: null },
      ],
    },
    {
      id: "turn-2",
      status: "interrupted",
      items: [],
    },
  ]);
  expect(actions.map((action) => action.type)).toContain("status");
  expect(snapshot(timeline).state.turn).toBe("aborted");
  const user = items(timeline).find((item) => item.kind === "user-message");
  // The id Corral sent as `clientUserMessageId` is the item id, so a resume cannot duplicate it.
  expect(user).toMatchObject({ id: "user:ours", text: "hi" });
  expect(items(timeline).find((item) => item.kind === "assistant-message")).toMatchObject({
    text: "hello",
    streaming: false,
  });
});
