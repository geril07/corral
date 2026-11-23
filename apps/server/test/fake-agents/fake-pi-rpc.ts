import { spawn } from "node:child_process";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
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
 * - `links`: the same answer, naming a workspace path with a line and an ordinary web URL, so a
 *   test can click what chat's local-link rendering produces;
 * - `slow`: the same, after `$FAKE_PI_RPC_DELAY_MS` (default 500) mid-turn, so a test can abort,
 *   stop or restart while the agent works;
 * - `crash`: one delta and then exit code 3, the shape of a provider crash (after
 *   `$FAKE_PI_RPC_CRASH_DELAY_MS`, default 0, so a test can be watching when it happens);
 * - `badline`: one line that is not JSON, the shape of a broken protocol;
 * - `truncate`: a valid record cut off without LF, then exit 0, the shape of a lost tail;
 * - `silent`: start-up commands are never answered, so the ready deadline is exercised;
 * - `stuck-abort`: a prompt starts a turn that never settles, and `abort` is never answered — a pi
 *   that is alive but silent, which is what bounds a handoff's abort rather than a child's exit;
 * - `reject`: every message command answers `success:false`, the shape of a refused prompt;
 * - `noeof`: ignores stdin EOF and keeps a `sleep` in its process group (its pid is written to
 *   `<home>/<session>.grandchild`), so a test can prove the group is killed on stop.
 *
 * `$FAKE_PI_RPC_DIALOG=none` allows the edit without waiting, and `$FAKE_PI_RPC_CONTEXT=used/window`
 * makes the model report a window plus every assistant turn's usage: the dev stack's composer meter.
 * `$FAKE_PI_RPC_CLAMP=requested:applied` accepts a thinking level and keeps another, the silent
 * clamp measured on pi. `<home>/levels.json` overrides a model's levels for the next launch.
 * `$FAKE_PI_RPC_ACCEPT_DELAY_MS` delays a message command's answer (and its journal entry), so a
 * test can restart across the server's delivery window.
 * `<session>.commands.json` journals every accepted prompt/steer with its model and level, and every
 * applied model/level command, so a test can pin what a turn actually ran on.
 *
 * The journal lives under `$FAKE_PI_RPC_HOME`, keyed by `--session-id`, so a real server restart
 * resumes the same conversation exactly as pi's own session store would.
 */
export function startFakePiRpc(argv: readonly string[]): void {
  const sessionId = argValue(argv, "--session-id") ?? `fake-${process.pid}`;
  const home = process.env["FAKE_PI_RPC_HOME"] ?? join(tmpdir(), "fake-pi-rpc");
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  const journalPath = join(home, `${safeSessionId}.json`);
  // The model and level each accepted prompt/steer ran on, and every model/level command: a test
  // asserts which model a turn actually used, not just what the UI claims.
  const commandsPath = join(home, `${safeSessionId}.commands.json`);
  const mode = process.env["FAKE_PI_RPC"] ?? "normal";
  const delayMs = Number(process.env["FAKE_PI_RPC_DELAY_MS"] ?? 500);
  // How long the fake takes to answer a message command, so a test can observe the server's
  // `sending` state and restart across the boundary. The default is an immediate answer.
  const acceptDelayMs = Number(process.env["FAKE_PI_RPC_ACCEPT_DELAY_MS"] ?? 0);
  // The composer's context meter reads what pi reports, and a real answer costs a model call.
  // `FAKE_PI_RPC_CONTEXT="156000/200000"` is used tokens / window for this stand-in's turns; unset
  // keeps the fake silent about context, exactly as it was before the meter existed.
  const context = contextFixture(process.env["FAKE_PI_RPC_CONTEXT"]);
  const reportedUsage = context.tokens > 0 ? contextUsage(context.tokens) : undefined;
  const history = readJournal(journalPath);
  const dialogs = new Map<string, (answer: FakeDialogAnswer) => void>();
  let models = [
    { id: "stub-1", name: "Stub One", provider: "stub" },
    { id: "stub-2", name: "Stub Two", provider: "stub" },
  ];
  if (existsSync(join(home, "catalog.json"))) {
    models = z
      .array(z.object({ id: z.string(), name: z.string(), provider: z.string() }))
      .parse(JSON.parse(readFileSync(join(home, "catalog.json"), "utf8")));
  }
  const modelIndex = argv.indexOf("--model");
  const providerIndex = argv.indexOf("--provider");
  const launchModel =
    modelIndex < 0 || process.env["FAKE_PI_IGNORE_LAUNCH_MODEL"] === "1"
      ? undefined
      : argv[modelIndex + 1];
  const launchProvider = providerIndex < 0 ? undefined : argv[providerIndex + 1];
  let currentModel =
    models.find(
      (model) =>
        (launchProvider === undefined || model.provider === launchProvider) &&
        (launchModel === model.id || launchModel === `${model.provider}/${model.id}`),
    ) ?? models[0]!;
  let currentLevel = "medium";
  // `levels.json` in the fake's home replaces a model's levels for the next launch, so a test can
  // remove a remembered level and prove it is retained but not applied.
  const overridesPath = join(home, "levels.json");
  const levelOverrides = existsSync(overridesPath)
    ? z
        .record(z.string(), z.array(z.string()))
        .parse(JSON.parse(readFileSync(overridesPath, "utf8")))
    : undefined;
  const levelsOf = (model: { id: string }): readonly string[] =>
    levelOverrides?.[model.id] ?? levelsFor(model);

  /** The accepted prompt/steer and every applied model/level, so a test can pin the turn's model. */
  function journalCommand(entry: Record<string, unknown>): void {
    const journal = readJournal(commandsPath);
    journal.push({ ...entry, at: Date.now() });
    mkdirSync(dirname(commandsPath), { recursive: true });
    writeFileSync(commandsPath, JSON.stringify(journal));
  }
  let buffer = "";
  let dialogCount = 0;
  let running = false;
  let compacting = false;
  let aborted = false;
  let currentText = "";
  let currentUser: Record<string, unknown> | undefined;
  let recoveryCompactionStarted = false;
  let recoveryRetryStarted = false;

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
    // Alive, but never answers the abort: the handoff's wait must be bounded by it, not by it.
    // The marker lets a test know the abort arrived before it asks the server to shut down.
    if (mode === "stuck-abort" && type === "abort") {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, `${safeSessionId}.abort-seen`), String(Date.now()));
      return;
    }
    switch (type) {
      case "get_state":
        if (aborted && !running && process.env["FAKE_PI_RPC_HOLD_ABORT_PROBE"] === "1") return;
        if (!recoveryRetryStarted && existsSync(join(home, "recovery-retry"))) {
          recoveryRetryStarted = true;
          send({ type: "auto_retry_start", attempt: 1, maxAttempts: 2 });
        }
        if (!recoveryCompactionStarted && existsSync(join(home, "recovery-gated"))) {
          recoveryCompactionStarted = true;
          compacting = true;
          send({ type: "compaction_start" });
          void askConfirm().then(() => {
            compacting = false;
            send({ type: "compaction_end", result: { summary: "Compacted." } });
          });
        }
        if (existsSync(join(home, "recovery-race"))) send({ type: "agent_start" });
        if (mode === "truncate") {
          process.stdout.write('{"type":"agent_start"');
          process.exit(0);
        }
        respond(id, "get_state", {
          model: currentModel,
          thinkingLevel: currentLevel,
          isStreaming: running,
          isCompacting: compacting || existsSync(join(home, "recovery-busy")),
          pendingMessageCount: 0,
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
        if (
          existsSync(join(home, "catalog-error")) ||
          (argv.includes("--no-session") && existsSync(join(home, "catalog-only-error")))
        ) {
          reply(id, "get_available_models", { success: false, error: "secret-native-diagnostic" });
          return;
        }
        respond(id, "get_available_models", {
          models: (existsSync(join(home, "catalog-extra"))
            ? [...models, { id: "stub-3", name: "Stub Three", provider: "stub" }]
            : models
          ).map((model) => ({
            ...model,
            reasoning: true,
            thinkingLevelMap: levelMapOf(levelsOf(model)),
            ...(context.window > 0 ? { contextWindow: context.window } : {}),
          })),
        });
        return;
      case "get_available_thinking_levels":
        if (mode === "refresh-silent" && currentModel.id === "stub-2") return;
        if (mode === "refresh-fail" && currentModel.id === "stub-2") {
          reply(id, "get_available_thinking_levels", {
            success: false,
            error: "thinking refresh failed",
          });
          return;
        }
        respond(id, "get_available_thinking_levels", { levels: levelsOf(currentModel) });
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
        // Pi 1.5.2 and 1.6.0 reload the configured default on set_model, even for the same model.
        const defaultLevel = process.env["FAKE_PI_RPC_DEFAULT_LEVEL"] ?? "medium";
        currentLevel = levelsOf(model).includes(defaultLevel)
          ? defaultLevel
          : (levelsOf(model)[0] ?? "off");
        journalCommand({ type: "model", provider: currentModel.provider, id: currentModel.id });
        respond(id, "set_model", model);
        return;
      }
      case "set_thinking_level": {
        const level = typeof record["level"] === "string" ? record["level"] : "";
        if (!levelsOf(currentModel).includes(level)) {
          reply(id, "set_thinking_level", {
            success: false,
            error: `Thinking level not supported: ${level}`,
          });
          return;
        }
        const apply = () => {
          // A silent clamp is a measured pi behavior; the driver's read-back must confirm it.
          const clamp = clampPair(level);
          currentLevel = clamp ?? level;
          journalCommand({ type: "level", requested: level, applied: currentLevel });
          respond(id, "set_thinking_level");
          send({ type: "thinking_level_changed", level: currentLevel });
        };
        if (existsSync(join(home, "hold-thinking"))) {
          writeFileSync(join(home, "thinking-waiting"), level);
          void (async () => {
            while (existsSync(join(home, "hold-thinking"))) {
              // oxlint-disable-next-line no-await-in-loop -- the test controls the native acknowledgement
              await sleep(20);
            }
            apply();
          })();
        } else apply();
        return;
      }
      case "prompt":
      case "steer":
      case "follow_up": {
        const message = typeof record["message"] === "string" ? record["message"] : "";
        if (acceptDelayMs > 0) {
          // A real agent answers after it has read the message, not when stdin took it; the delay
          // is what lets a test pin the server's `sending` window and a restart across it.
          void (async () => {
            await sleep(acceptDelayMs);
            acceptMessage(type, id, message);
          })();
          return;
        }
        acceptMessage(type, id, message);
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

  /**
   * Answers one message command. Split from `handle` so a delayed answer still journals nothing
   * before it: a process killed during the delay is a message that was never accepted.
   */
  function acceptMessage(type: string, id: string | undefined, message: string): void {
    if (mode === "reject") {
      reply(id, type, { success: false, error: "the fake pi rejects messages" });
      return;
    }
    journalCommand({
      type,
      text: message,
      model: currentModel.id,
      provider: currentModel.provider,
      level: currentLevel,
    });
    if (type !== "prompt" && (running || compacting)) {
      if (type === "steer" && process.env["FAKE_PI_RPC_HOLD_STEER_ACK"] === "1") {
        const release = join(home, `${safeSessionId}.steer-release`);
        journalCommand({ type: "steer-awaiting-ack" });
        const watcher = watch(home, () => {
          if (!existsSync(release)) return;
          watcher.close();
          respond(id, type, { disposition: "queued" });
        });
      } else {
        respond(id, type, { disposition: "queued" });
      }
      send({ type: "queue_update", steering: type === "steer" ? [message] : [], followUp: [] });
      return;
    }
    respond(id, type, { disposition: type === "prompt" ? "started" : "queued" });
    void runTurn(message);
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
      ...(reportedUsage === undefined ? {} : { usage: reportedUsage }),
    };
    currentUser = user;
    send({ type: "agent_start" });
    send({ type: "turn_start" });
    // Working forever: no delta, no settle, and the abort above is ignored.
    if (mode === "stuck-abort") return;
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

    // `links` keeps the first sentence identical, so a test that only wants the answer still finds
    // it, and adds what chat renders as a file link and a web link.
    const text =
      mode === "links"
        ? "Here is the answer.\nSee src/app.ts:12 and https://example.com/docs for the details."
        : "Here is the answer.";
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
    // A seeded dev task should land on a settled turn; a test that answers the dialog sets neither.
    const confirmed =
      process.env["FAKE_PI_RPC_DIALOG"] === "none"
        ? { confirmed: true, cancelled: false }
        : await askConfirm();
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
    if (process.env["FAKE_PI_RPC_POST_SETTLE_COMPACTION"] === "1") {
      compacting = true;
      journalCommand({ type: "compaction-start" });
      send({ type: "compaction_start" });
      await askConfirm();
      compacting = false;
      journalCommand({ type: "compaction-end" });
      send({ type: "compaction_end", result: { summary: "Compacted." } });
    }
  }

  function settleAborted(): void {
    if (currentUser !== undefined) {
      const assistant: Record<string, unknown> = {
        role: "assistant",
        content: currentText === "" ? [] : [{ type: "text", text: currentText }],
        stopReason: "aborted",
        timestamp: Date.now(),
        ...(reportedUsage === undefined ? {} : { usage: reportedUsage }),
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

/** pi's thinking levels are per model: the second model adds `max` and has no `low`. */
function levelsFor(model: { id: string }): readonly string[] {
  return model.id === "stub-2"
    ? ["off", "medium", "high", "max"]
    : ["off", "low", "medium", "high"];
}

/**
 * `$FAKE_PI_RPC_CLAMP=high:medium` accepts `high` and keeps `medium`, the silent clamp measured on
 * pi; the driver's read-back must notice instead of reporting the requested level.
 */
function clampPair(level: string): string | undefined {
  const [requested, applied] = (process.env["FAKE_PI_RPC_CLAMP"] ?? "").split(":");
  return requested === level && applied !== undefined && applied !== "" ? applied : undefined;
}

/**
 * pi's `thinkingLevelMap` for an exact set of levels: a level it does not take is `null`, and
 * `xhigh`/`max` are absent because those need an explicit mapping.
 */
function levelMapOf(levels: readonly string[]): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    if (levels.includes(level)) {
      if (level === "xhigh" || level === "max") map[level] = level;
    } else if (level !== "xhigh" && level !== "max") map[level] = null;
  }
  return map;
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

/** `FAKE_PI_RPC_CONTEXT` as `used/window` in tokens; a missing or malformed value reports nothing. */
function contextFixture(value: string | undefined): { tokens: number; window: number } {
  const [tokens, window] = (value ?? "").split("/").map(Number);
  return { tokens: positiveInteger(tokens), window: positiveInteger(window) };
}

function positiveInteger(value: number | undefined): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : 0;
}

/** pi's `Usage`, reduced to the counts the projection reads; `reasoning` sits inside `output`. */
function contextUsage(tokens: number): Record<string, number> {
  const output = Math.round(tokens / 10);
  return { input: tokens - output, output, cacheRead: 0, cacheWrite: 0, totalTokens: tokens };
}
