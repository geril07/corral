import type { ChatItem, ChatToolCall } from "@corral/protocol/chat";
import { expect, test } from "vite-plus/test";
import { chatRows, pendingRequest, toolSummary } from "./chat-rows.ts";

const call = (id: string, status: ChatToolCall["status"]): ChatToolCall => ({
  kind: "tool-call",
  id,
  name: "read",
  arguments: `{"path":"${id}.ts"}`,
  status,
  output: null,
  diff: null,
});

const user: ChatItem = { kind: "user-message", id: "u", text: "hello" };

test("consecutive finished tool calls fold; a running call stays its own row", () => {
  expect(chatRows([call("a", "done"), call("b", "error"), call("c", "running")])).toEqual([
    { kind: "tools", key: "tools:a", items: [call("a", "done"), call("b", "error")] },
    { kind: "item", key: "c", item: call("c", "running") },
  ]);
});

test("a single finished call is not a group, and a user message breaks the run", () => {
  expect(chatRows([user, call("a", "done"), call("b", "done"), user])).toEqual([
    { kind: "item", key: "u", item: user },
    { kind: "tools", key: "tools:a", items: [call("a", "done"), call("b", "done")] },
    { kind: "item", key: "u", item: user },
  ]);
  expect(chatRows([call("a", "done")])).toEqual([
    { kind: "item", key: "a", item: call("a", "done") },
  ]);
});

test("the argument hint reads the first string of the shape, not the tool name", () => {
  expect(toolSummary('{"path":"src/a.ts","edits":[]}')).toBe("src/a.ts");
  expect(toolSummary('{"command":"pnpm test"}')).toBe("pnpm test");
  expect(toolSummary("not json")).toBe("not json");
  expect(toolSummary('{"count":2}')).toBe('{"count":2}');
});

test("the last pending request is the one the view answers", () => {
  const answered: ChatItem = {
    kind: "user-request",
    id: "q1",
    request: "confirm",
    title: "Proceed?",
    body: null,
    options: [],
    placeholder: null,
    prefill: null,
    expiresAt: null,
    status: "answered",
    answer: true,
  };
  const pending: ChatItem = {
    ...answered,
    id: "q2",
    status: "pending",
    answer: undefined,
  };
  expect(pendingRequest([answered])).toBeUndefined();
  expect(pendingRequest([answered, pending])?.id).toBe("q2");
});
