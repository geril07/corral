import { expect, test } from "vite-plus/test";
import { PiLineReader, PiRecordError, type PiRecord } from "./pi-record.ts";
import { PiProjection, type PiAction } from "./pi-projection.ts";
import { ChatTimeline } from "./timeline.ts";

const NOW = 1_700_000_000_000;
const DIALOG_TIMEOUT = 60_000;

function projection() {
  const timeline = new ChatTimeline();
  const created = new PiProjection(timeline, {
    now: () => NOW,
    dialogTimeoutMs: DIALOG_TIMEOUT,
  });
  const apply = (...records: PiRecord[]): PiAction[] =>
    records.flatMap((record) => created.apply(record));
  return { timeline, created, apply };
}

function userMessage(text: string): PiRecord {
  return { type: "message_start", message: { role: "user", content: text } };
}

function assistantAt(timeline: ChatTimeline, id: string) {
  const item = timeline.item(id);
  return item?.kind === "assistant-message" ? item : undefined;
}

test("records are split on LF only, at any chunk boundary, with CRLF accepted", () => {
  const first = JSON.stringify({ type: "agent_start", note: "a\u2028b\u2029c" });
  const second = JSON.stringify({ type: "agent_settled", aborted: false });
  const text = `${first}\r\n${second}\n`;
  const expected = ["agent_start", "agent_settled"];
  for (let split = 1; split < text.length; split++) {
    const reader = new PiLineReader();
    const records = [...reader.push(text.slice(0, split)), ...reader.push(text.slice(split))];
    expect(records.map((record) => record["type"])).toEqual(expected);
    // U+2028 and U+2029 stayed inside the string instead of ending the record.
    expect(records[0]!["note"]).toBe("a\u2028b\u2029c");
    expect(reader.finish()).toEqual([]);
  }
});

test("a malformed line and a truncated record at EOF are parse failures, never silent drops", () => {
  const reader = new PiLineReader();
  expect(() => reader.push("not json\n")).toThrow(PiRecordError);
  const truncated = new PiLineReader();
  truncated.push('{"type":"agent_start"');
  expect(() => truncated.finish()).toThrow(PiRecordError);
});

test("a turn becomes items: user message, streamed answer, tool call with a unified diff, settled state", () => {
  const { timeline, created, apply } = projection();
  const userId = created.userMessage("please edit it");
  expect(timeline.item(userId)).toEqual({
    kind: "user-message",
    id: userId,
    text: "please edit it",
  });

  const actions = apply(
    { type: "agent_start" },
    userMessage("please edit it"),
    { type: "message_start", message: { role: "assistant", content: [] } },
    ...["Here ", "is ", "the answer."].map((delta) => ({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
    })),
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 1,
        id: "call_1",
        toolName: "edit",
      },
    },
  );
  expect(actions).toEqual([{ type: "status", state: "working" }]);
  expect(timeline.state.turn).toBe("working");

  const assistant = timeline.snapshot().items.find((item) => item.kind === "assistant-message");
  expect(assistant).toMatchObject({ text: "Here is the answer.", streaming: true });

  const tool = timeline.snapshot().items.find((item) => item.kind === "tool-call");
  expect(tool).toMatchObject({ id: "tool-call_1", name: "edit", status: "running", arguments: "" });

  apply(
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          type: "toolCall",
          id: "call_1",
          name: "edit",
          arguments: { path: "notes.txt", edits: [{ oldText: "old", newText: "new" }] },
        },
      },
    },
    {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "edit",
      args: { path: "notes.txt" },
    },
    {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "edit",
      isError: false,
      result: {
        content: [{ type: "text", text: "Successfully replaced 1 block(s) in notes.txt." }],
        details: {
          diff: "-1 old\n+1 new",
          patch: "--- notes.txt\n+++ notes.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n",
        },
      },
    },
    { type: "agent_settled", aborted: false },
  );

  expect(timeline.snapshot().items.filter((item) => item.kind === "tool-call")).toEqual([
    {
      kind: "tool-call",
      id: "tool-call_1",
      name: "edit",
      arguments: '{"path":"notes.txt","edits":[{"oldText":"old","newText":"new"}]}',
      status: "done",
      output: "Successfully replaced 1 block(s) in notes.txt.",
      diff: {
        path: "notes.txt",
        // The contract's diff is the unified patch, not pi's compact `details.diff`.
        text: "--- notes.txt\n+++ notes.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n",
      },
    },
  ]);
  const messages = timeline.snapshot().items.filter((item) => item.kind === "assistant-message");
  expect(messages).toEqual([
    {
      kind: "assistant-message",
      id: expect.any(String),
      text: "Here is the answer.",
      streaming: false,
    },
  ]);
  expect(timeline.state.turn).toBe("settled");
  // The deltas were streamed as deltas, not only as one final item.
  expect(timeline.eventsAfter(0)?.some((entry) => entry.event.type === "delta")).toBe(true);
});

test("the authoritative message_end replaces what the deltas streamed", () => {
  const { timeline, apply } = projection();
  apply(
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "draft" },
    },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "final" },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final" }],
        stopReason: "stop",
      },
    },
  );
  expect(timeline.snapshot().items).toEqual([
    { kind: "assistant-message", id: expect.any(String), text: "final", streaming: false },
  ]);
});

function streamedAnswer(
  text: string,
  startModel?: { provider: string; model: string },
  endModel?: { provider: string; model: string },
): PiRecord[] {
  return [
    { type: "message_start", message: { role: "assistant", content: [], ...startModel } },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
        ...endModel,
      },
    },
  ];
}

test("each live answer takes the model its own message reports, never the session's", () => {
  const { timeline, created, apply } = projection();
  apply(
    // The model is on the message from its start.
    ...streamedAnswer("first", { provider: "alpha", model: "a-1" }),
    // A start without one still gets it from the authoritative end.
    ...streamedAnswer("second", undefined, { provider: "beta", model: "b-2" }),
    // No model anywhere: the answer stays unattributed.
    ...streamedAnswer("third"),
  );
  created.loadModelState(
    { model: { id: "c-3", provider: "gamma" } },
    [{ id: "c-3", provider: "gamma", contextWindow: 1_000 }],
    [],
  );
  const messages = timeline.snapshot().items.filter((item) => item.kind === "assistant-message");
  expect(messages[0]?.model).toEqual({ provider: "alpha", id: "a-1" });
  expect(messages[1]?.model).toEqual({ provider: "beta", id: "b-2" });
  expect(messages[2] !== undefined && "model" in messages[2]).toBe(false);
  expect(messages.map((item) => item.text)).toEqual(["first", "second", "third"]);
});

test("a rebuilt transcript keeps a model per answer and leaves an unknown one absent", () => {
  const { timeline, created } = projection();
  created.loadHistory([
    {
      role: "assistant",
      content: [{ type: "text", text: "older" }],
      provider: "alpha",
      model: "a-1",
      stopReason: "stop",
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "newest" }],
      provider: "beta",
      model: "b-2",
      stopReason: "stop",
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "unattributed" }],
      stopReason: "stop",
    },
  ]);
  created.loadModelState(
    { model: { id: "c-3", provider: "gamma" } },
    [{ id: "c-3", provider: "gamma", contextWindow: 1_000 }],
    [],
  );
  expect(assistantAt(timeline, "h-0-c0")?.model).toEqual({ provider: "alpha", id: "a-1" });
  expect(assistantAt(timeline, "h-1-c0")?.model).toEqual({ provider: "beta", id: "b-2" });
  const unattributed = assistantAt(timeline, "h-2-c0");
  expect(unattributed !== undefined && "model" in unattributed).toBe(false);
});

test("a dialog request is an item the client answers with the record pi expects", () => {
  const { timeline, created, apply } = projection();
  const actions = apply({
    type: "extension_ui_request",
    id: "ui-1",
    method: "confirm",
    title: "Apply the edit?",
    message: "notes.txt will change.",
  });

  expect(actions).toEqual([
    {
      type: "dialog-opened",
      itemId: "request-ui-1",
      piRequestId: "ui-1",
      expiresAt: NOW + DIALOG_TIMEOUT,
    },
    { type: "status", state: "blocked", kind: "question", message: "Apply the edit?" },
  ]);
  expect(timeline.item("request-ui-1")).toMatchObject({
    kind: "user-request",
    request: "confirm",
    title: "Apply the edit?",
    body: "notes.txt will change.",
    options: [],
    status: "pending",
    expiresAt: NOW + DIALOG_TIMEOUT,
  });

  const response = created.respond("request-ui-1", true);
  expect(response).toEqual({ type: "extension_ui_response", id: "ui-1", confirmed: true });
  expect(timeline.item("request-ui-1")).toMatchObject({ status: "answered", answer: true });

  // A second answer for the same item is not a pending request any more.
  expect(created.respond("request-ui-1", false)).toBeUndefined();
});

test("dismissing a dialog cancels it, and expiring it sends a cancel and marks the item", () => {
  const { timeline, created, apply } = projection();
  apply({
    type: "extension_ui_request",
    id: "ui-2",
    method: "select",
    title: "Pick",
    options: ["A", "B"],
  });

  expect(created.respond("request-ui-2", null)).toEqual({
    type: "extension_ui_response",
    id: "ui-2",
    cancelled: true,
  });
  expect(timeline.item("request-ui-2")).toMatchObject({ status: "answered", answer: null });

  apply({
    type: "extension_ui_request",
    id: "ui-3",
    method: "editor",
    title: "Write",
    prefill: "line",
  });
  expect(created.expire("request-ui-3")).toEqual({
    item: expect.objectContaining({ status: "expired" }),
    piRequestId: "ui-3",
  });
  expect(timeline.item("request-ui-3")).toMatchObject({ status: "expired" });
  expect(created.pendingRequests).toEqual([]);
});

test("a request still pending when the run settles is expired, and nothing is left streaming", () => {
  const { timeline, created, apply } = projection();
  apply(
    { type: "message_start", message: { role: "assistant", content: [] } },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "half" },
    },
    { type: "extension_ui_request", id: "ui-4", method: "confirm", title: "Continue?" },
  );
  const actions = apply({ type: "agent_settled", aborted: false });
  expect(actions).toContainEqual({ type: "status", state: "done" });
  expect(actions).toContainEqual({ type: "dialog-closed", itemId: "request-ui-4" });
  expect(timeline.item("request-ui-4")).toMatchObject({ status: "expired" });
  expect(created.pendingRequests).toEqual([]);
  expect(timeline.snapshot().items.find((item) => item.kind === "assistant-message")).toMatchObject(
    {
      streaming: false,
    },
  );
});

test("an aborted run reports idle instead of done", () => {
  const { timeline, apply } = projection();
  expect(apply({ type: "agent_start" })).toEqual([{ type: "status", state: "working" }]);
  expect(apply({ type: "agent_settled", aborted: true })).toEqual([
    { type: "status", state: "idle" },
  ]);
  expect(timeline.state.turn).toBe("aborted");
});

test("a provider error is an error item and the error status", () => {
  const { timeline, apply } = projection();
  const actions = apply({
    type: "message_update",
    assistantMessageEvent: { type: "error", reason: "529 overloaded" },
  });
  expect(actions).toEqual([{ type: "status", state: "error" }]);
  expect(timeline.state.turn).toBe("error");
  expect(timeline.snapshot().items).toEqual([
    { kind: "error", id: expect.any(String), text: "529 overloaded" },
  ]);
});

test("history is rebuilt from pi's own messages, with tool results and their diffs", () => {
  const { timeline, created } = projection();
  created.loadHistory([
    { role: "system", content: "the prompt" },
    { role: "user", content: "edit notes.txt" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Doing it." },
        { type: "toolCall", id: "call_9", name: "edit", arguments: { path: "notes.txt" } },
      ],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: "call_9",
      toolName: "edit",
      content: [{ type: "text", text: "Successfully replaced 1 block(s) in notes.txt." }],
      details: { patch: "--- notes.txt\n+++ notes.txt\n@@ -1 +1 @@\n-old\n+new\n" },
      isError: false,
    },
    { role: "user", content: [{ type: "text", text: "thanks" }] },
  ]);

  expect(timeline.snapshot().items).toEqual([
    { kind: "user-message", id: "h-1", text: "edit notes.txt" },
    { kind: "assistant-message", id: "h-2-c0", text: "Doing it.", streaming: false },
    {
      kind: "tool-call",
      id: "tool-call_9",
      name: "edit",
      arguments: '{"path":"notes.txt"}',
      status: "done",
      output: "Successfully replaced 1 block(s) in notes.txt.",
      diff: { path: "notes.txt", text: "--- notes.txt\n+++ notes.txt\n@@ -1 +1 @@\n-old\n+new\n" },
    },
    { kind: "user-message", id: "h-4", text: "thanks" },
  ]);
});

test("the model list and the current model come from pi's state commands", () => {
  const { timeline, created } = projection();
  created.loadModelState(
    { model: { id: "stub-1", name: "Stub One", provider: "stub" }, thinkingLevel: "high" },
    [{ id: "stub-2", name: "Stub Two", provider: "stub" }],
    ["off", "high"],
  );
  expect(timeline.state).toMatchObject({
    model: { provider: "stub", id: "stub-1", name: "Stub One" },
    models: [{ provider: "stub", id: "stub-2", name: "Stub Two" }],
    reasoning: "high",
    reasoningLevels: ["off", "high"],
  });
});

test("model reasoning capabilities distinguish unknown and unsupported and respect pi's level map", () => {
  const { timeline, created } = projection();
  created.loadModelState(
    {},
    [
      { id: "unknown", provider: "stub" },
      { id: "plain", provider: "stub", reasoning: false },
      {
        id: "reasoning",
        provider: "stub",
        reasoning: true,
        thinkingLevelMap: { minimal: null, xhigh: "extra", max: null },
      },
      { id: "standard", provider: "stub", reasoning: true },
    ],
    [],
  );
  expect(timeline.state.models).toEqual([
    { id: "unknown", name: "unknown", provider: "stub" },
    { id: "plain", name: "plain", provider: "stub", reasoningLevels: [] },
    {
      id: "reasoning",
      name: "reasoning",
      provider: "stub",
      reasoningLevels: ["off", "low", "medium", "high", "xhigh"],
    },
    {
      id: "standard",
      name: "standard",
      provider: "stub",
      reasoningLevels: ["off", "minimal", "low", "medium", "high"],
    },
  ]);
});

test("a queue update carries the steering, and leaves the server's follow-up queue alone", () => {
  const { timeline, apply } = projection();
  apply({ type: "queue_update", steering: ["wait"], followUp: ["then this"] });
  expect(timeline.state.steering).toEqual(["wait"]);
  // The server owns the queue; pi's native follow-up is not the same list.
  expect(timeline.state.followUp).toEqual([]);
});

test("unknown and malformed fields are ignored instead of throwing", () => {
  const { timeline, apply } = projection();
  expect(
    apply(
      { type: "message_update" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta" } },
      { type: "extension_ui_request", method: "setStatus", statusKey: "k" },
      { type: "extension_ui_request" },
      { type: "some_future_event", data: 1 },
      { type: "tool_execution_end", toolCallId: 7 },
    ),
  ).toEqual([]);
  expect(timeline.snapshot().items).toEqual([]);
});

test("an assistant message's usage becomes the context reading, against the model's own window", () => {
  const { timeline, created, apply } = projection();
  created.loadModelState(
    { model: { id: "stub-1", name: "Stub One", provider: "stub" } },
    [{ id: "stub-1", name: "Stub One", provider: "stub", contextWindow: 200_000 }],
    [],
  );
  apply(
    { type: "message_start", message: { role: "assistant", content: [] } },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: {
          input: 1_000,
          output: 500,
          cacheRead: 40_000,
          cacheWrite: 100,
          totalTokens: 41_600,
        },
      },
    },
  );
  expect(timeline.state.context).toEqual({ usedTokens: 41_600, maxTokens: 200_000 });

  // The compaction replaces the conversation the reading described; pi reports nothing until the
  // next response arrives.
  apply({ type: "compaction_start", reason: "auto" });
  expect(timeline.state.context).toBeNull();
});

test("a rebuilt transcript reads its last assistant message on resume", () => {
  const { timeline, created } = projection();
  created.loadModelState(
    { model: { id: "stub-1", name: "Stub One", provider: "stub" } },
    [{ id: "stub-1", name: "Stub One", provider: "stub", contextWindow: 200_000 }],
    [],
  );
  created.loadHistory([
    {
      role: "assistant",
      content: [{ type: "text", text: "older" }],
      stopReason: "stop",
      usage: { input: 1_000, output: 100, cacheRead: 10_000, cacheWrite: 0 },
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "newest" }],
      stopReason: "stop",
      usage: { input: 2_000, output: 300, cacheRead: 30_000, cacheWrite: 0 },
    },
  ]);
  expect(timeline.state.context).toEqual({ usedTokens: 32_300, maxTokens: 200_000 });
});
