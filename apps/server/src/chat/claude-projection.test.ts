import { expect, test } from "vite-plus/test";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeProjection, diffOf } from "./claude-projection.ts";
import { ChatTimeline } from "./timeline.ts";
import {
  assistantText,
  assistantToolUse,
  replayOf,
  streamText,
  toolResult,
} from "../../test/fake-agents/fake-claude-sdk.ts";

function projection(options: { dialogTimeoutMs?: number } = {}): {
  projection: ClaudeProjection;
  timeline: ChatTimeline;
} {
  const timeline = new ChatTimeline(0);
  return {
    timeline,
    projection: new ClaudeProjection(timeline, {
      now: () => 1000,
      dialogTimeoutMs: options.dialogTimeoutMs ?? 60_000,
    }),
  };
}

test("a file tool's structuredPatch becomes the unified diff the contract promises", () => {
  const diff = diffOf({
    filePath: "notes.txt",
    structuredPatch: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-old", "+new"],
      },
    ],
  });
  expect(diff).toEqual({
    path: "notes.txt",
    text: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1,1 +1,1 @@\n-old\n+new",
  });
  // A result with neither shape has no diff, and a read has none either.
  expect(diffOf({ filePath: "notes.txt" })).toBeNull();
  expect(diffOf("plain output")).toBeNull();
});

test("Claude Write without a structured patch retains its input and has no diff", () => {
  const { projection: map, timeline } = projection();
  map.apply(assistantToolUse("m", "write-1", "Write", { file_path: "new.ts", content: "hello" }));
  map.apply(toolResult("write-1", "File created", { toolUseResult: { filePath: "new.ts" } }));
  const call = timeline.snapshot().items.find((item) => item.kind === "tool-call");
  expect(call).toMatchObject({ name: "Write", status: "done", diff: null });
  if (call?.kind !== "tool-call") throw new Error("Write call missing");
  expect(JSON.parse(call.arguments)).toEqual({ file_path: "new.ts", content: "hello" });
});

test("a streamed block is not consumed by an assistant frame of another message", () => {
  const { projection: map, timeline } = projection();
  for (const message of streamText("msg_a", ["half a sen"])) map.apply(message);
  // The CLI sends one assistant frame per completed block; a frame from another message (a
  // synthetic turn, an error message) must not take over a stream that is still live.
  map.apply(assistantText("msg_b", "Echo"));
  const items = timeline.snapshot().items;
  expect(items.find((item) => item.id === "text:msg_a:0")).toMatchObject({
    text: "half a sen",
    streaming: true,
  });
  expect(
    items.find(
      (item) => item.kind === "assistant-message" && item.text === "Echo" && !item.streaming,
    ),
  ).toBeDefined();
  // The block's own final frame replaces the streamed item, in place.
  map.apply(assistantText("msg_a", "half a sentence"));
  expect(
    timeline.snapshot().items.filter((item) => item.kind === "assistant-message"),
  ).toHaveLength(2);
  expect(timeline.item("text:msg_a:0")).toMatchObject({
    text: "half a sentence",
    streaming: false,
  });
});

test("a replayed user frame is ignored; the rebuilt transcript is the history", () => {
  const { projection: map, timeline } = projection();
  const replay = replayOf(toolResult("toolu_1", "should not appear"));
  expect(map.apply(replay)).toEqual([]);
  expect(timeline.snapshot().items).toHaveLength(0);
});

test("an unanswered request expires with a denial and cannot be answered afterwards", async () => {
  const { projection: map, timeline } = projection({ dialogTimeoutMs: 25 });
  const { itemId, result } = map.openPermission({
    toolUseID: "toolu_1",
    name: "Bash",
    input: { command: "ls" },
    title: "Bash wants to run ls",
  });
  expect(timeline.item(itemId)).toMatchObject({
    kind: "user-request",
    status: "pending",
    expiresAt: 1025,
  });
  expect(map.expire(itemId)).toBe(true);
  expect(map.answer(itemId, "allow")).toBe(false);
  expect(timeline.item(itemId)).toMatchObject({ status: "expired", answer: null });
  await expect(result).resolves.toMatchObject({ behavior: "deny" });
});

test("an 'always allow' answer carries the CLI's own permission rules", async () => {
  const { projection: map, timeline } = projection();
  const suggestions: PermissionUpdate[] = [
    { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" },
  ];
  const { itemId, result } = map.openPermission({
    toolUseID: "toolu_2",
    name: "Bash",
    input: { command: "ls" },
    suggestions,
  });
  expect(map.answer(itemId, "allow-always")).toBe(true);
  await expect(result).resolves.toMatchObject({
    behavior: "allow",
    updatedPermissions: suggestions,
    decisionClassification: "user_permanent",
  });
  expect(timeline.item(itemId)).toMatchObject({ status: "answered", answer: "allow-always" });
});
