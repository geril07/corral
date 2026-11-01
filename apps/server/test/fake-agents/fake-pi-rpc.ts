import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "../../src/chat/pi-record.ts";

/**
 * A stand-in for `pi --mode rpc`: strict JSONL on stdin/stdout, one scripted turn, and a journal
 * on disk so a resumed process answers `get_messages` with what the previous one wrote.
 *
 * Modes, all through `$FAKE_PI_RPC`:
 * - `normal` (default): assistant text deltas, an `edit` tool call with a unified diff, a
 *   `confirm` dialog that waits for the client's answer, then `agent_settled`;
 * - `slow`: the same, after `$FAKE_PI_RPC_DELAY_MS` (default 500) mid-turn, so a test can abort,
 *   stop or restart while the agent works;
 * - `crash`: one delta and then exit code 3, the shape of a provider crash (after
 *   `$FAKE_PI_RPC_CRASH_DELAY_MS`, default 0, so a test can be watching when it happens);
 * - `badline`: one line that is not JSON, the shape of a broken protocol;
 * - `truncate`: a valid record cut off without LF, then exit 0, the shape of a lost tail;
 * - `silent`: start-up commands are never answered, so the ready deadline is exercised;
 * - `reject`: every message command answers `success:false`, the shape of a refused prompt;
 * - `noeof`: ignores stdin EOF and keeps a `sleep` in its process group (its pid is written to
 *   `<home>/<session>.grandchild`), so a test can prove the group is killed on stop.
 *
 * The journal lives under `$FAKE_PI_RPC_HOME`, keyed by `--session-id`, so a real server restart
 * resumes the same conversation exactly as pi's own session store would.
 */
export function startFakePiRpc(argv: readonly string[]): void {
  const sessionId = argValue(argv, "--session-id") ?? `fake-${process.pid}`;
  const home = process.env["FAKE_PI_RPC_HOME"] ?? join(tmpdir(), "fake-pi-rpc");
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  const journalPath = join(home, `${safeSessionId}.json`);
  const mode = process.env["FAKE_PI_RPC"] ?? "normal";
  const delayMs = Number(process.env["FAKE_PI_RPC_DELAY_MS"] ?? 500);
  const history = readJournal(journalPath);
  const dialogs = new Map<string, (answer: FakeDialogAnswer) => void>();
  const models = [
    { id: "stub-1", name: "Stub One", provider: "stub" },
    { id: "stub-2", name: "Stub Two", provider: "stub" },
  ];
  // pi's thinking levels are per model: the second model adds `max` and has no `low`.
  const levelsFor = (model: { id: string }): readonly string[] =>
    model.id === "stub-2" ? ["off", "medium", "high", "max"] : ["off", "low", "medium", "high"];
  let currentModel = models[0]!;
  let currentLevel = "medium";
  let buffer = "";
  let dialogCount = 0;
  let running = false;
  let aborted = false;
  let currentText = "";
  let currentUser: Record<string, unknown> | undefined;

  process.stdout.on("error", () => process.exit(0));
  if (mode === "noeof") {
    // A real handle keeps Node alive after stdin ends; a grandchild proves the group kill.
    setInterval(() => undefined, 1000);
    const grandchild = spawn("sleep", ["60"], { stdio: "ignore" });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, `${safeSessionId}.grandchild`), String(grandchild.pid));
  }
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line !== "") {
        const record: unknown = JSON.parse(line);
        if (isRecord(record)) handle(record);
      }
      newline = buffer.indexOf("\n");
    }
  });
  // pi closes on stdin EOF (measured on 1.4.0), so the fake does too, unless the mode ignores it.
  process.stdin.on("end", () => {
    if (mode !== "noeof") process.exit(0);
  });

  function handle(record: Record<string, unknown>): void {
    const id = typeof record["id"] === "string" ? record["id"] : undefined;
    const type = record["type"];
    if (type === "extension_ui_response") {
      const rawId = record["id"];
      const requestId = typeof rawId === "string" ? rawId : "";
      const answer = dialogs.get(requestId);
      if (answer === undefined) return;
      dialogs.delete(requestId);
      answer({
        confirmed: record["confirmed"] === true,
        value: typeof record["value"] === "string" ? record["value"] : undefined,
        cancelled: record["cancelled"] === true,
      });
      return;
    }
    if (mode === "silent" && type !== "abort") return;
    switch (type) {
      case "get_state":
        if (mode === "truncate") {
          process.stdout.write('{"type":"agent_start"');
          process.exit(0);
        }
        respond(id, "get_state", {
          model: currentModel,
          thinkingLevel: currentLevel,
          isStreaming: running,
          messageCount: history.length,
          sessionId,
          sessionFile: journalPath,
        });
        return;
      case "get_messages":
        respond(id, "get_messages", {
          messages: [{ role: "system", content: "fake pi system prompt" }, ...history],
        });
        return;
      case "get_available_models":
        respond(id, "get_available_models", { models });
        return;
      case "get_available_thinking_levels":
        respond(id, "get_available_thinking_levels", { levels: levelsFor(currentModel) });
        return;
      case "set_model": {
        const model = models.find(
          (candidate) =>
            candidate.id === record["modelId"] && candidate.provider === record["provider"],
        );
        if (model === undefined) {
          reply(id, "set_model", {
            success: false,
            error: `Model not found: ${String(record["provider"])}/${String(record["modelId"])}`,
          });
          return;
        }
        currentModel = model;
        // pi clamps a level the new model does not take; the driver reads it back with `get_state`.
        if (!levelsFor(model).includes(currentLevel)) currentLevel = "medium";
        respond(id, "set_model", model);
        return;
      }
      case "set_thinking_level": {
        const level = typeof record["level"] === "string" ? record["level"] : "";
        if (!levelsFor(currentModel).includes(level)) {
          reply(id, "set_thinking_level", {
            success: false,
            error: `Thinking level not supported: ${level}`,
          });
          return;
        }
        currentLevel = level;
        respond(id, "set_thinking_level");
        send({ type: "thinking_level_changed", level });
        return;
      }
      case "prompt":
      case "steer":
      case "follow_up": {
        const message = typeof record["message"] === "string" ? record["message"] : "";
        if (mode === "reject") {
          reply(id, type, { success: false, error: "the fake pi rejects messages" });
          return;
        }
        respond(id, type, { disposition: type === "prompt" ? "started" : "queued" });
        if (type !== "prompt" && running) {
          send({ type: "queue_update", steering: type === "steer" ? [message] : [], followUp: [] });
          return;
        }
        void runTurn(message);
        return;
      }
      case "abort":
        aborted = true;
        for (const [requestId, answer] of dialogs) {
          answer({ confirmed: false, cancelled: true });
          dialogs.delete(requestId);
        }
        respond(id, "abort");
        if (!running) send({ type: "agent_settled", aborted: true });
        return;
      default:
        reply(id, String(type), {
          success: false,
          error: `fake pi does not implement ${String(type)}`,
        });
        return;
    }
  }

  async function runTurn(message: string): Promise<void> {
    if (running) return;
    running = true;
    aborted = false;
    currentText = "";
    const user: Record<string, unknown> = { role: "user", content: message, timestamp: Date.now() };
    const assistant: Record<string, unknown> = {
      role: "assistant",
      content: [],
      stopReason: "pending",
      timestamp: Date.now(),
    };
    currentUser = user;
    send({ type: "agent_start" });
    send({ type: "turn_start" });
    if (mode === "badline") {
      process.stdout.write("this is not a pi record\n");
      return;
    }
    if (mode === "crash") {
      send({ type: "message_start", message: assistant });
      send({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "half" },
      });
      const delay = Number(process.env["FAKE_PI_RPC_CRASH_DELAY_MS"] ?? 0);
      if (delay > 0) await sleep(delay);
      process.exit(3);
    }
    send({ type: "message_start", message: user });
    send({ type: "message_end", message: user });
    send({ type: "message_start", message: assistant });
    if (mode === "slow") await sleep(delayMs);
    if (aborted) return settleAborted();

    const text = "Here is the answer.";
    for (const [index, word] of text.split(" ").entries()) {
      if (aborted) return settleAborted();
      const delta = index === 0 ? word : ` ${word}`;
      currentText += delta;
      send({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
      });
    }
    const args = { path: "notes.txt", edits: [{ oldText: "old", newText: "new" }] };
    send({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 1,
        id: "call_1",
        toolName: "edit",
      },
    });
    send({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 1,
        delta: JSON.stringify(args),
      },
    });
    const toolCall = { type: "toolCall", id: "call_1", name: "edit", arguments: args };
    send({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall },
    });
    send({ type: "tool_execution_start", toolCallId: "call_1", toolName: "edit", args });
    const confirmed = await askConfirm();
    if (aborted) return settleAborted();
    const result = {
      content: [{ type: "text", text: "Successfully replaced 1 block(s) in notes.txt." }],
      details: {
        diff: "-1 old\n+1 new",
        patch: "--- notes.txt\n+++ notes.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n",
        firstChangedLine: 1,
      },
    };
    const isError = !confirmed.confirmed;
    send({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "edit",
      result: isError ? { content: [{ type: "text", text: "The user declined." }] } : result,
      isError,
    });
    const toolResult: Record<string, unknown> = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "edit",
      content: isError ? [{ type: "text", text: "The user declined." }] : result.content,
      details: isError ? undefined : result.details,
      isError,
      timestamp: Date.now(),
    };
    if (isError) delete toolResult["details"];
    assistant["content"] = [
      { type: "text", text: currentText },
      { ...toolCall, type: "toolCall" },
    ];
    assistant["stopReason"] = "toolUse";
    send({ type: "message_end", message: assistant });
    send({ type: "turn_end", message: assistant, toolResults: [toolResult] });
    send({ type: "agent_end", messages: [assistant], willRetry: false });
    append([user, assistant, toolResult]);
    running = false;
    currentUser = undefined;
    send({ type: "agent_settled", aborted: false });
  }

  function settleAborted(): void {
    if (currentUser !== undefined) {
      const assistant: Record<string, unknown> = {
        role: "assistant",
        content: currentText === "" ? [] : [{ type: "text", text: currentText }],
        stopReason: "aborted",
        timestamp: Date.now(),
      };
      append([currentUser, assistant]);
      send({ type: "message_end", message: assistant });
    }
    running = false;
    currentUser = undefined;
    send({ type: "agent_end", messages: [], willRetry: false });
    send({ type: "agent_settled", aborted: true });
  }

  function askConfirm(): Promise<FakeDialogAnswer> {
    const id = `ui-${(dialogCount += 1)}`;
    send({
      type: "extension_ui_request",
      id,
      method: "confirm",
      title: "Apply the edit?",
      message: "notes.txt will change.",
    });
    return new Promise((resolve) => dialogs.set(id, resolve));
  }

  function append(messages: Record<string, unknown>[]): void {
    history.push(...messages);
    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(journalPath, JSON.stringify(history));
  }
}

/** One record on stdout; the only place the fake writes its protocol. */
function send(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

/** A success `response` for `id`. */
function respond(id: string | undefined, commandName: string, data?: unknown): void {
  reply(id, commandName, { success: true, ...(data === undefined ? {} : { data }) });
}

/** A `response` record with the request's id echoed, as pi answers every command. */
function reply(
  id: string | undefined,
  commandName: string,
  fields: { success: boolean; data?: unknown; error?: string },
): void {
  send({ ...(id === undefined ? {} : { id }), type: "response", command: commandName, ...fields });
}

interface FakeDialogAnswer {
  confirmed: boolean;
  value?: string | undefined;
  cancelled: boolean;
}

function readJournal(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord);
  } catch {
    return [];
  }
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
