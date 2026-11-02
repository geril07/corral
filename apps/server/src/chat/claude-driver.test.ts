import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import type { ChatItem } from "@corral/protocol/chat";
import type { AgentStatus } from "@corral/protocol/rpc";
import { ChatService } from "./chat-service.ts";
import {
  ClaudeDriver,
  claudeChatDriver,
  claudeVersionError,
  historyIsReadable,
  type ClaudeDriverRequest,
} from "./claude-driver.ts";
import { chatLaunchHow } from "../sessions/session-service.ts";
import { ChatModelUnsupportedError, ChatReasoningUnsupportedError } from "./chat-errors.ts";
import { ChatTimeline } from "./timeline.ts";
import { writerPath } from "./writer-claim.ts";
import { FAKE_BIN, useFakeAgents } from "../../test/fake-agents.ts";
import {
  FakeClaudeSdk,
  assistantText,
  claudeInit,
  assistantToolUse,
  resultError,
  resultSuccess,
  sessionMessage,
  streamText,
  toolResult,
} from "../../test/fake-agents/fake-claude-sdk.ts";
import { processExists } from "../../test/session-helpers.ts";
import { writeClaudeTranscript } from "../../test/claude-transcripts.ts";

const agents = useFakeAgents();
const COMMAND = join(FAKE_BIN, "claude");
const SESSION_ID = "11111111-2222-4333-8444-555555555555";

interface Harness {
  driver: ClaudeDriver;
  timeline: ChatTimeline;
  sdk: FakeClaudeSdk;
  statuses: AgentStatus[];
  exited: Promise<string | null>;
  recordedPids: number[];
  released: boolean;
  request: ClaudeDriverRequest;
  stop(): Promise<void>;
}

function noop(): void {}

async function harness(
  options: {
    sdk?: FakeClaudeSdk;
    prompt?: string | null;
    how?: "start" | "resume";
    sessionId?: string;
    model?: string | null;
    readyTimeoutMs?: number;
    dialogTimeoutMs?: number;
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "corral-claude-"));
  const timeline = new ChatTimeline(0);
  const statuses: AgentStatus[] = [];
  let resolveExit: (reason: string | null) => void = noop;
  const exited = new Promise<string | null>((resolve) => (resolveExit = resolve));
  const recordedPids: number[] = [];
  const state = { released: false };
  const request: ClaudeDriverRequest = {
    sessionId: "corral-session-1",
    timeline,
    command: COMMAND,
    args: [],
    cwd: root,
    env: processEnv(),
    model: options.model ?? null,
    how: options.how ?? "start",
    prompt: options.prompt ?? null,
    agentSessionId: options.sessionId ?? SESSION_ID,
    writer: {
      record: (pid) => recordedPids.push(pid),
      release: () => {
        state.released = true;
      },
    },
    dialogTimeoutMs: options.dialogTimeoutMs ?? 3000,
    readyTimeoutMs: options.readyTimeoutMs ?? 5000,
    exitGraceMs: 400,
    onStatus: (status) => statuses.push(status),
    onExit: (reason) => resolveExit(reason),
  };
  const sdk = options.sdk ?? new FakeClaudeSdk();
  const driver = new ClaudeDriver(request, sdk);
  return {
    driver,
    timeline,
    sdk,
    statuses,
    exited,
    recordedPids,
    get released() {
      return state.released;
    },
    request,
    stop: async () => {
      await driver.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Starts the driver and waits until the session state exists (history and models are loaded). */
async function started(h: Harness): Promise<void> {
  h.driver.start();
  await until(() => h.timeline.state.models.length > 0, "the session state");
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function until(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    // oxlint-disable-next-line no-await-in-loop -- one poll per tick until the signal arrives
    await new Promise((settle) => setTimeout(settle, 5));
  }
}

function item<K extends ChatItem["kind"]>(
  timeline: ChatTimeline,
  kind: K,
): Extract<ChatItem, { kind: K }> | undefined {
  return timeline
    .snapshot()
    .items.find(
      (candidate): candidate is Extract<ChatItem, { kind: K }> => candidate.kind === kind,
    );
}

test("start names our session id and sends the user's executable and environment", async () => {
  const h = await harness({ prompt: "Do the thing" });
  try {
    await started(h);
    await h.sdk.onlyQuery.whenPrompted(1);
    const options = h.sdk.options[0]!;
    expect(options.sessionId).toBe(SESSION_ID);
    expect(options.resume).toBeUndefined();
    expect(options.pathToClaudeCodeExecutable).toBe(COMMAND);
    expect(options.permissionMode).toBe("default");
    expect(options.includePartialMessages).toBe(true);
    expect(options.settingSources).toBeUndefined();
    expect(options.env).toMatchObject({ CLAUDE_CONFIG_DIR: process.env["CLAUDE_CONFIG_DIR"] });
    expect(typeof options.canUseTool).toBe("function");
    // No `dir`: a narrowed read can report an existing conversation as empty.
    expect(h.sdk.historyCalls).toEqual([{ sessionId: SESSION_ID, dir: undefined }]);
    // The model list is the SDK's; the selected model is the one `init` reported.
    expect(h.timeline.state.models.map((model) => model.id)).toEqual(["default", "sonnet"]);
    expect(h.timeline.state.model).toMatchObject({ id: "default", provider: null });
    expect(h.timeline.state.reasoningLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(item(h.timeline, "user-message")).toMatchObject({ text: "Do the thing" });
  } finally {
    await h.stop();
  }
});

test("a resumed conversation loads its transcript and is never prompted again", async () => {
  const sdk = new FakeClaudeSdk({
    history: [
      sessionMessage("user", "u1", "Remember the note"),
      sessionMessage("assistant", "a1", [{ type: "text", text: "Here is the answer." }]),
      sessionMessage("assistant", "a2", [
        {
          type: "tool_use",
          id: "toolu_edit",
          name: "Edit",
          input: { file_path: "notes.txt", old_string: "a", new_string: "b" },
        },
      ]),
      sessionMessage("user", "u2", [
        { type: "tool_result", tool_use_id: "toolu_edit", content: "Edited notes.txt" },
      ]),
    ],
  });
  const h = await harness({ sdk, prompt: "Remember the note", how: "resume" });
  try {
    await started(h);
    await h.sdk.whenHistoryRead();
    // Let the driver's own continuation after the transcript read run: the prompt decision is
    // synchronous from there, so a sent prompt is in `received` by the next macrotask.
    await new Promise((settle) => setTimeout(settle, 0));
    expect(h.sdk.options[0]?.resume).toBe(SESSION_ID);
    expect(h.sdk.options[0]?.sessionId).toBeUndefined();
    expect(h.sdk.onlyQuery.received).toHaveLength(0);
    expect(h.timeline.snapshot().items.filter((each) => each.kind === "user-message")).toHaveLength(
      1,
    );
    expect(item(h.timeline, "assistant-message")).toMatchObject({
      text: "Here is the answer.",
      streaming: false,
    });
    expect(item(h.timeline, "tool-call")).toMatchObject({
      name: "Edit",
      status: "done",
      output: "Edited notes.txt",
    });
  } finally {
    await h.stop();
  }
});

test("a resume with no transcript starts under the same id and sends the prompt once", async () => {
  // The P1 review case: the terminal leg asks `hasConversation` before resuming, and chat must
  // too. Claude writes no transcript before the first prompt, so a "resume" here is a "start".
  const env = processEnv();
  const how = chatLaunchHow("claude", SESSION_ID, "resume", env);
  expect(how).toBe("start");
  const h = await harness({ prompt: "Do the thing", how, sessionId: SESSION_ID });
  try {
    await started(h);
    await h.sdk.onlyQuery.whenPrompted(1);
    expect(h.sdk.options[0]?.sessionId).toBe(SESSION_ID);
    expect(h.sdk.options[0]?.resume).toBeUndefined();
    expect(h.sdk.onlyQuery.received).toHaveLength(1);
  } finally {
    await h.stop();
  }
});

test("a resume whose transcript exists keeps resume and sends no prompt", async () => {
  const configDir = process.env["CLAUDE_CONFIG_DIR"]!;
  writeClaudeTranscript(configDir, await mkdtemp(join(tmpdir(), "corral-claude-cwd-")), SESSION_ID);
  const env = processEnv();
  const how = chatLaunchHow("claude", SESSION_ID, "resume", env);
  expect(how).toBe("resume");
  const sdk = new FakeClaudeSdk({
    history: [sessionMessage("user", "u1", "Already asked")],
  });
  const h = await harness({ sdk, prompt: "Already asked", how, sessionId: SESSION_ID });
  try {
    await started(h);
    await h.sdk.whenHistoryRead();
    await new Promise((settle) => setTimeout(settle, 0));
    expect(h.sdk.options[0]?.resume).toBe(SESSION_ID);
    expect(h.sdk.options[0]?.sessionId).toBeUndefined();
    expect(h.sdk.onlyQuery.received).toHaveLength(0);
  } finally {
    await h.stop();
  }
});

test("a resume the SDK refuses fails visibly and sends no prompt", async () => {
  // The SDK's own failure for a missing conversation is `supportedModels()` ("No conversation
  // found with session ID …"), which is why the launch must not get there in the first place; the
  // path is still visible if the transcript disappears between the check and the spawn.
  const sdk = new FakeClaudeSdk({
    modelsFails: "No conversation found with session ID: 11111111-2222-4333-8444-555555555555",
  });
  const h = await harness({ sdk, prompt: "Do the thing", how: "resume" });
  try {
    h.driver.start();
    const reason = await h.exited;
    expect(reason).toContain("No conversation found");
    expect(h.sdk.onlyQuery.received).toHaveLength(0);
    expect(item(h.timeline, "error")?.text).toContain("No conversation found");
  } finally {
    await h.stop();
  }
});

test("a hanging --version names the 5 s deadline, not a generic command failure", () => {
  expect(
    claudeVersionError(
      "/opt/claude",
      { message: "Command failed: /opt/claude --version", killed: true, signal: "SIGTERM" },
      "",
    ),
  ).toBe("the claude at /opt/claude did not answer --version within 5 s");
  expect(claudeVersionError("/opt/claude", { message: "spawn /opt/claude ENOENT" }, "")).toContain(
    "could not run /opt/claude --version",
  );
});

test("a start under our id on a conversation that already has a user message sends no prompt", async () => {
  // The C1 P0 class: the transcript, not the launch mode, decides whether the prompt is handed over.
  const sdk = new FakeClaudeSdk({
    history: [sessionMessage("user", "u1", "Already asked")],
  });
  const h = await harness({ sdk, prompt: "Already asked", how: "start" });
  try {
    await started(h);
    await h.sdk.whenHistoryRead();
    await new Promise((settle) => setTimeout(settle, 0));
    expect(h.sdk.options[0]?.sessionId).toBe(SESSION_ID);
    expect(h.sdk.onlyQuery.received).toHaveLength(0);
  } finally {
    await h.stop();
  }
});

test("an unreadable transcript sends no prompt and says why", async () => {
  const sdk = new FakeClaudeSdk({ historyFails: true });
  const h = await harness({ sdk, prompt: "Do it" });
  try {
    await started(h);
    await until(() => item(h.timeline, "notice") !== undefined, "the prompt notice");
    expect(h.sdk.onlyQuery.received).toHaveLength(0);
    expect(item(h.timeline, "notice")?.text).toContain("was not sent again");
  } finally {
    await h.stop();
  }
});

test("a launch whose config dir the SDK cannot read does not trust an empty history", () => {
  const launch = { CLAUDE_CONFIG_DIR: "/tmp/one", HOME: "/home/x" };
  expect(historyIsReadable(launch, { CLAUDE_CONFIG_DIR: "/tmp/two" })).toBe(false);
  expect(historyIsReadable(launch, { CLAUDE_CONFIG_DIR: "/tmp/one" })).toBe(true);
  expect(historyIsReadable({ HOME: "/home/x" }, { HOME: "/home/x" })).toBe(true);
  expect(historyIsReadable({ HOME: "/home/x" }, { HOME: "/home/y" })).toBe(false);
});

test("streamed text arrives as deltas and the final message replaces the same item", async () => {
  const h = await harness();
  try {
    await started(h);
    for (const message of streamText("msg_stream", ["Hel", "lo wo", "rld"]))
      h.sdk.onlyQuery.emit(message);
    await until(
      () => item(h.timeline, "assistant-message")?.text === "Hello world",
      "the streamed text",
    );
    expect(item(h.timeline, "assistant-message")).toMatchObject({ streaming: true });
    h.sdk.onlyQuery.emit(assistantText("msg_stream", "Hello world"));
    await until(
      () => item(h.timeline, "assistant-message")?.streaming === false,
      "the settled message",
    );
    const messages = h.timeline
      .snapshot()
      .items.filter((each) => each.kind === "assistant-message");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ text: "Hello world" });
    const deltas = (h.timeline.eventsAfter(0) ?? []).filter(
      (event) => event.event.type === "delta",
    );
    expect(deltas.length).toBeGreaterThan(0);
  } finally {
    await h.stop();
  }
});

test("a tool call carries the unified diff its result reports", async () => {
  const patch = "--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-old\n+new\n";
  const h = await harness();
  try {
    await started(h);
    h.sdk.onlyQuery.emit(
      assistantToolUse("msg_tool", "toolu_edit", "Edit", {
        file_path: "notes.txt",
        old_string: "old",
        new_string: "new",
      }),
    );
    await until(() => item(h.timeline, "tool-call") !== undefined, "the running tool call");
    expect(item(h.timeline, "tool-call")).toMatchObject({ status: "running", name: "Edit" });
    h.sdk.onlyQuery.emit(
      toolResult("toolu_edit", "Edited notes.txt", {
        toolUseResult: {
          filePath: "notes.txt",
          gitDiff: { filename: "notes.txt", status: "modified", patch },
        },
      }),
    );
    await until(() => item(h.timeline, "tool-call")?.status === "done", "the tool result");
    expect(item(h.timeline, "tool-call")).toMatchObject({
      output: "Edited notes.txt",
      diff: { path: "notes.txt", text: patch },
    });
  } finally {
    await h.stop();
  }
});

test("a permission request is one user request, answered once, and a second answer is refused", async () => {
  const sdk = new FakeClaudeSdk({
    turn: (query) => {
      query.emit(assistantToolUse("msg_bash", "toolu_bash", "Bash", { command: "ls" }));
      void query.options
        .canUseTool?.(
          "Bash",
          { command: "ls" },
          {
            signal: new AbortController().signal,
            toolUseID: "toolu_bash",
            requestId: "req_1",
            title: "Bash wants to run ls",
            suggestions: [
              {
                type: "addRules",
                rules: [{ toolName: "Bash" }],
                behavior: "allow",
                destination: "session",
              },
            ],
          },
        )
        .then((result) => {
          query.emit(toolResult("toolu_bash", result?.behavior === "allow" ? "listed" : "denied"));
          query.emit(resultSuccess("done"));
        });
    },
  });
  const h = await harness({ sdk });
  try {
    await started(h);
    h.driver.send("list the files", "prompt");
    await until(() => item(h.timeline, "user-request") !== undefined, "the permission request");
    const request = item(h.timeline, "user-request")!;
    expect(request).toMatchObject({
      id: "permission:toolu_bash",
      request: "select",
      status: "pending",
      title: "Bash wants to run ls",
      expiresAt: expect.any(Number),
    });
    expect(request.options.map((option) => option.value)).toEqual([
      "allow",
      "allow-always",
      "deny",
    ]);
    expect(h.statuses.at(-1)?.state).toBe("blocked");
    h.driver.respond(request.id, "allow");
    await until(() => item(h.timeline, "user-request")?.status === "answered", "the answer");
    await until(() => h.timeline.state.turn === "settled", "the settled turn");
    expect(item(h.timeline, "user-request")).toMatchObject({ status: "answered", answer: "allow" });
    expect(item(h.timeline, "tool-call")).toMatchObject({ status: "done", output: "listed" });
    // The answer resolved that one promise; a second one names an item that is not pending.
    expect(() => h.driver.respond(request.id, "deny")).toThrowError(/not waiting for an answer/);
  } finally {
    await h.stop();
  }
});

test("denying a request answers the CLI with a denial and expires after the deadline", async () => {
  const answers: string[] = [];
  const sdk = new FakeClaudeSdk({
    turn: (query) => {
      void query.options
        .canUseTool?.(
          "Write",
          { file_path: "notes.txt" },
          {
            signal: new AbortController().signal,
            toolUseID: "toolu_write",
            requestId: "req_2",
          },
        )
        .then((result) => answers.push(result?.behavior ?? "none"));
    },
  });
  const h = await harness({ sdk, dialogTimeoutMs: 50 });
  try {
    await started(h);
    h.driver.send("write it", "prompt");
    await until(() => item(h.timeline, "user-request") !== undefined, "the permission request");
    // No answer: the server stops waiting and denies, so the CLI is not left parked.
    await until(() => item(h.timeline, "user-request")?.status === "expired", "the expiry");
    expect(answers).toEqual(["deny"]);
  } finally {
    await h.stop();
  }
});

test("interrupt ends the turn and a pending request is expired", async () => {
  const sdk = new FakeClaudeSdk({
    turn: (query) => {
      query.emit(assistantToolUse("msg_bash", "toolu_bash", "Bash", { command: "ls" }));
      void query.options.canUseTool?.(
        "Bash",
        { command: "ls" },
        { signal: new AbortController().signal, toolUseID: "toolu_bash", requestId: "req_3" },
      );
    },
  });
  const h = await harness({ sdk });
  try {
    await started(h);
    h.driver.send("list the files", "prompt");
    await until(() => h.sdk.onlyQuery.received.length === 1, "the prompt");
    await until(() => item(h.timeline, "user-request") !== undefined, "the permission request");
    await h.driver.abort();
    expect(h.sdk.onlyQuery.interrupted).toBe(1);
    expect(item(h.timeline, "user-request")?.status).toBe("expired");
    h.sdk.onlyQuery.emit(resultSuccess());
    await until(() => h.timeline.state.turn === "aborted", "the aborted turn");
    expect(h.statuses.at(-1)?.state).toBe("idle");
  } finally {
    await h.stop();
  }
});

test("a model and reasoning change reaches the SDK, and a level the model lacks is refused", async () => {
  const h = await harness();
  try {
    await started(h);
    await expect(h.driver.setModel({ provider: null, id: "not-a-model" })).rejects.toBeInstanceOf(
      ChatModelUnsupportedError,
    );
    await h.driver.setModel({ provider: null, id: "sonnet" });
    expect(h.sdk.onlyQuery.modelCalls).toEqual(["sonnet"]);
    expect(h.timeline.state.model).toMatchObject({ id: "sonnet", name: "Sonnet" });
    expect(h.timeline.state.reasoningLevels).toEqual(["low", "high"]);
    await expect(h.driver.setReasoning("max")).rejects.toBeInstanceOf(
      ChatReasoningUnsupportedError,
    );
    await h.driver.setReasoning("high");
    expect(h.sdk.onlyQuery.effortCalls).toEqual(["high"]);
    expect(h.timeline.state.reasoning).toBe("high");
  } finally {
    await h.stop();
  }
});

test("a reasoning level set before the first turn survives the init frame", async () => {
  // The CLI sends `system:init` with the first turn, so a level chosen before it is in the state but
  // not in the frame; the frame must not clear a level the model still takes.
  const sdk = new FakeClaudeSdk({ silent: true });
  const h = await harness({ sdk });
  try {
    await started(h);
    await h.driver.setReasoning("high");
    expect(h.timeline.state.reasoning).toBe("high");
    h.sdk.onlyQuery.emit(claudeInit("claude-opus-5-5", null));
    await until(() => h.timeline.state.model?.id === "default", "the init frame's model");
    expect(h.timeline.state.reasoning).toBe("high");
  } finally {
    await h.stop();
  }
});

test("an untested claude version refuses chat with the sentence and starts nothing", async () => {
  vi.stubEnv("FAKE_CLAUDE_VERSION", "2.1.300");
  const h = await harness();
  try {
    h.driver.start();
    const reason = await h.exited;
    expect(reason).toContain("2.1.300");
    expect(reason).toContain("2.1.316");
    expect(reason).toContain("terminal");
    expect(h.sdk.queries).toHaveLength(0);
    expect(h.recordedPids).toEqual([]);
    expect(h.driver.closed).toBe(true);
  } finally {
    await h.stop();
  }
});

test("a stop closes the query, kills the recorded writer and leaves no streaming item", async () => {
  const sdk = new FakeClaudeSdk({ spawnChild: true, turn: () => {} });
  const h = await harness({ sdk });
  try {
    await started(h);
    h.driver.send("start a long turn", "prompt");
    await until(() => h.recordedPids.length === 1, "the recorded writer");
    const pid = h.recordedPids[0]!;
    expect(processExists(pid)).toBe(true);
    for (const message of streamText("msg_slow", ["half a sen"])) h.sdk.onlyQuery.emit(message);
    await until(
      () => item(h.timeline, "assistant-message")?.text === "half a sen",
      "the partial text",
    );
    const reason = h.exited;
    await h.driver.stop();
    expect(await reason).toBeNull();
    expect(h.sdk.onlyQuery.closed).toBe(true);
    await until(() => !processExists(pid), "the child's exit");
    expect(h.released).toBe(true);
    expect(item(h.timeline, "assistant-message")).toMatchObject({
      text: "half a sen",
      streaming: false,
    });
    expect(h.timeline.closed).toBe(true);
  } finally {
    await h.stop();
  }
});

test("a stop kills the group when the CLI ignores stdin EOF and SIGTERM", async () => {
  const sdk = new FakeClaudeSdk({ spawnChild: true, stubbornChild: true, turn: () => {} });
  const h = await harness({ sdk });
  try {
    await started(h);
    h.driver.send("start a long turn", "prompt");
    await until(() => h.recordedPids.length === 1, "the recorded writer");
    const pid = h.recordedPids[0]!;
    await h.driver.stop();
    await until(() => !processExists(pid), "the killed group");
    expect(h.released).toBe(true);
  } finally {
    await h.stop();
  }
});

test("a frontend that ends while its CLI still runs keeps the writer record", async () => {
  const sdk = new FakeClaudeSdk({ spawnChild: true, turn: () => {} });
  const h = await harness({ sdk });
  try {
    await started(h);
    h.driver.send("start a long turn", "prompt");
    await until(() => h.recordedPids.length === 1, "the recorded writer");
    const pid = h.recordedPids[0]!;
    // The stream ends, the process does not: the next launch must stop or await it, so the record
    // stays (releasing it here would delete a newer launch's record, which is the same path).
    h.sdk.onlyQuery.end();
    const reason = await h.exited;
    expect(reason).toContain("claude exited");
    expect(h.released).toBe(false);
    expect(processExists(pid)).toBe(true);
    expect(h.timeline.closed).toBe(true);
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone; the harness's stop below would otherwise leave it running.
    }
  } finally {
    await h.stop();
  }
});

test("a crash reports its reason and leaves an error item", async () => {
  const h = await harness();
  try {
    await started(h);
    h.sdk.onlyQuery.fail("claude exited unexpectedly (code 2)");
    const reason = await h.exited;
    expect(reason).toContain("code 2");
    expect(h.statuses.at(-1)?.state).toBe("error");
    expect(item(h.timeline, "error")?.text).toContain("code 2");
  } finally {
    await h.stop();
  }
});

test("a claude that never answers its model list fails the ready deadline", async () => {
  const sdk = new FakeClaudeSdk({ modelsHang: true });
  const h = await harness({ sdk, readyTimeoutMs: 300 });
  try {
    h.driver.start();
    const reason = await h.exited;
    expect(reason).toContain("did not answer within");
    expect(h.driver.closed).toBe(true);
  } finally {
    await h.stop();
  }
});

test("a failed turn is an error result with the CLI's own text", async () => {
  const h = await harness();
  try {
    await started(h);
    h.driver.send("fail please", "prompt");
    await until(() => h.sdk.onlyQuery.received.length === 1, "the prompt");
    h.sdk.onlyQuery.emit(resultError("the model call failed"));
    await until(() => h.timeline.state.turn === "error", "the failed turn");
    expect(item(h.timeline, "error")?.text).toContain("the model call failed");
  } finally {
    await h.stop();
  }
});

/**
 * The handoff path through the service: chat, then the fake TUI `claude --resume <id>`, then chat
 * again. The writer record is the one-writer rule, and the transcript's user message is what stops
 * the task prompt from being sent a second time.
 */
test("a handoff to the TUI on the same id leaves one writer and sends no prompt on the way back", async () => {
  const root = await mkdtemp(join(tmpdir(), "corral-claude-handoff-"));
  const sdks: FakeClaudeSdk[] = [];
  const chat = new ChatService({
    dataDir: root,
    drivers: {
      claude: {
        ...claudeChatDriver,
        create: (launch) => {
          // The transcript decides: the first launch has none, the resume's has the user's message.
          const sdk = new FakeClaudeSdk({
            spawnChild: true,
            history: launch.how === "resume" ? [sessionMessage("user", "u1", "Do the thing")] : [],
          });
          sdks.push(sdk);
          return new ClaudeDriver(launch, sdk);
        },
      },
    },
    timeouts: { dialogTimeoutMs: 2000, readyTimeoutMs: 5000, exitGraceMs: 400, writerWaitMs: 2000 },
  });
  const sessionId = "corral-session-handoff";
  const cwd = join(root, "workspace");
  await mkdir(cwd, { recursive: true });
  const statuses: AgentStatus[] = [];
  const exitReasons: (string | null)[] = [];
  try {
    await chat.launch({
      sessionId,
      kind: "claude",
      command: COMMAND,
      cwd,
      env: processEnv(),
      model: null,
      provider: null,
      agentSessionId: SESSION_ID,
      how: "start",
      prompt: "Do the thing",
      onStatus: (status) => statuses.push(status),
      onExit: (reason) => exitReasons.push(reason),
    });
    // The launch's own prompt went to the fake SDK, and the fake spawned a real placeholder CLI
    // whose pid the driver recorded as the session's writer.
    const pid = await untilPidFile(root, sessionId);
    expect(processExists(pid)).toBe(true);
    await sdks[0]!.onlyQuery.whenPrompted(1);

    await chat.stop(sessionId);
    // The chat writer is gone before the terminal leg starts: one writer at a time.
    await until(() => !processExists(pid), "the chat child's exit");
    expect(existsSync(writerPath(join(root, "chat"), sessionId))).toBe(false);

    // The TUI leg, on the same id, as the session service starts it: `claude --resume <id>`.
    writeClaudeTranscript(process.env["CLAUDE_CONFIG_DIR"]!, cwd, SESSION_ID);
    const tui = await runTui(cwd, SESSION_ID);
    try {
      const launches = await agents.launches();
      const resume = launches.find(
        (launch) => launch.agent === "claude" && launch.argv[0] === "--resume",
      );
      expect(resume?.argv).toEqual(["--resume", SESSION_ID]);
      expect(resume?.pid).not.toBe(pid);
      expect(processExists(resume!.pid)).toBe(true);
      expect(processExists(pid)).toBe(false);
    } finally {
      tui.stdin.end("exit\n");
      await tui.exited;
    }

    // Back to chat: the transcript already has the user's message, so the resume sends no prompt.
    await chat.launch({
      sessionId,
      kind: "claude",
      command: COMMAND,
      cwd,
      env: processEnv(),
      model: null,
      provider: null,
      agentSessionId: SESSION_ID,
      how: "resume",
      prompt: "Do the thing",
      onStatus: (status) => statuses.push(status),
      onExit: (reason) => exitReasons.push(reason),
    });
    const resumed = sdks[1]!;
    await resumed.whenHistoryRead();
    await new Promise((settle) => setTimeout(settle, 0));
    expect(resumed.options[0]?.resume).toBe(SESSION_ID);
    expect(resumed.onlyQuery.received).toHaveLength(0);
    // The chat is one writer again, and the only reason chat ended was the stop the user asked for.
    expect(await untilPidFile(root, sessionId)).toBeGreaterThan(0);
    await chat.stop(sessionId);
    expect(exitReasons.filter((reason) => reason !== null)).toEqual([]);
  } finally {
    await chat.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

async function workspace(root: string): Promise<string> {
  const path = join(root, "workspace");
  await mkdir(path, { recursive: true });
  return path;
}

async function untilPidFile(root: string, sessionId: string): Promise<number> {
  const path = writerPath(join(root, "chat"), sessionId);
  await until(() => existsSync(path), "the writer record");
  const record: unknown = JSON.parse(await readFile(path, "utf8"));
  const pid =
    typeof record === "object" && record !== null ? Reflect.get(record, "pid") : undefined;
  if (typeof pid !== "number") throw new Error("the writer record has no pid");
  return pid;
}

async function runTui(
  cwd: string,
  id: string,
): Promise<{ stdin: NodeJS.WritableStream; exited: Promise<void> }> {
  const child = spawn(COMMAND, ["--resume", id], { cwd, env: processEnv(), stdio: "pipe" });
  const stdin = child.stdin;
  if (stdin === null) throw new Error("the fake TUI has no stdin");
  const exited = new Promise<void>((settle) => child.once("exit", () => settle()));
  let ready = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (ready += chunk));
  // The journal is written before the fake prints its ready line, so this is also the barrier that
  // makes the launch visible to the assertions below.
  await until(() => ready.includes("fake claude ready"), "the fake TUI's readiness");
  return { stdin, exited };
}

test("a live chat writer is stopped before a terminal launch can start", async () => {
  const root = await mkdtemp(join(tmpdir(), "corral-claude-writer-"));
  const chat = new ChatService({
    dataDir: root,
    drivers: {
      claude: {
        ...claudeChatDriver,
        create: (launch) => new ClaudeDriver(launch, new FakeClaudeSdk({ spawnChild: true })),
      },
    },
    timeouts: { dialogTimeoutMs: 2000, readyTimeoutMs: 5000, exitGraceMs: 400, writerWaitMs: 2000 },
  });
  const sessionId = "corral-session-writer";
  try {
    await chat.launch({
      sessionId,
      kind: "claude",
      command: COMMAND,
      cwd: await workspace(root),
      env: processEnv(),
      model: null,
      provider: null,
      agentSessionId: SESSION_ID,
      how: "start",
      prompt: null,
      onStatus: () => {},
      onExit: () => {},
    });
    const pid = await untilPidFile(root, sessionId);
    expect(processExists(pid)).toBe(true);
    // The terminal's launch path calls this first; it stops the recorded writer, so the TUI can
    // never write beside the chat frontend.
    await chat.releaseWriterBeforeTerminal(sessionId);
    await until(() => !processExists(pid), "the stopped writer");
    expect(existsSync(writerPath(join(root, "chat"), sessionId))).toBe(false);
  } finally {
    await chat.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});
