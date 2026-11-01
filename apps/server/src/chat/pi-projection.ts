import type {
  ChatAnswer,
  ChatDiff,
  ChatItem,
  ChatModel,
  ChatRequestKind,
  ChatToolCall,
  ChatUserRequest,
} from "@corral/protocol/chat";
import type { AgentState } from "@corral/protocol/rpc";
import {
  arrayField,
  booleanField,
  contentText,
  numberField,
  isRecord,
  objectField,
  recordsField,
  stringField,
  stringsField,
  typeOf,
  type PiRecord,
} from "./pi-record.ts";
import { ChatTimeline } from "./timeline.ts";

/** What the driver has to do after a record: run a dialog timer, or report the agent's status. */
export type PiAction =
  | { type: "dialog-opened"; itemId: string; piRequestId: string; expiresAt: number }
  | { type: "dialog-closed"; itemId: string }
  | { type: "status"; state: AgentState; kind?: "question"; message?: string };

export interface PiProjectionOptions {
  /** Epoch milliseconds; injectable so a test can pin a dialog's deadline. */
  now: () => number;
  /** How long a pending dialog request waits before the server stops waiting. */
  dialogTimeoutMs: number;
}

interface PendingDialog {
  piRequestId: string;
  request: ChatRequestKind;
}

interface LiveBlock {
  itemId: string;
  kind: "text" | "thinking" | "tool";
}

interface LiveAssistant {
  blocks: Map<number, LiveBlock>;
}

const DIALOG_METHODS: Record<string, ChatRequestKind> = {
  select: "select",
  confirm: "confirm",
  input: "input",
  editor: "editor",
};

/**
 * Turns pi's RPC records into the chat contract (`packages/protocol/src/chat.ts`): items, streamed
 * deltas and the session-level state. Pure apart from the timeline it writes to, so the mapping is
 * tested by feeding records, with no child process involved.
 *
 * It also owns the pending dialog requests: opening one, answering it (the response record pi
 * expects), expiring it, and the rule that a dialog still pending when the run settles or the
 * frontend stops can no longer be answered.
 */
export class PiProjection {
  readonly #timeline: ChatTimeline;
  readonly #now: () => number;
  readonly #dialogTimeoutMs: number;
  readonly #dialogs = new Map<string, PendingDialog>();
  /** Where the tool call's `path` argument came from, for the diff of its result. */
  readonly #toolPaths = new Map<string, string>();
  #nextId = 0;
  #live: LiveAssistant | undefined;

  constructor(timeline: ChatTimeline, options: PiProjectionOptions) {
    this.#timeline = timeline;
    this.#now = options.now;
    this.#dialogTimeoutMs = options.dialogTimeoutMs;
  }

  /** The item ids of the requests pi still waits on, oldest first. */
  get pendingRequests(): string[] {
    return [...this.#dialogs.keys()];
  }

  /** Appends the user's own message and returns its id, which `chat.send` hands back. */
  userMessage(text: string): string {
    const id = `user-${(this.#nextId += 1)}`;
    this.#timeline.put({ kind: "user-message", id, text });
    return id;
  }

  /** One record of pi's stdout; returns what the driver must do about it. */
  apply(record: PiRecord): PiAction[] {
    switch (typeOf(record)) {
      case "agent_start":
        this.#timeline.setState({ turn: "working" });
        return [{ type: "status", state: "working" }];
      case "agent_settled":
        return this.#settled(booleanField(record, "aborted") === true);
      case "message_start":
        this.#messageStart(record);
        return [];
      case "message_update":
        return this.#messageUpdate(record);
      case "message_end":
        return this.#messageEnd(record);
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        this.#toolExecution(record);
        return [];
      case "extension_ui_request":
        return this.#extensionRequest(record);
      case "queue_update":
        this.#timeline.setState({
          steering: stringsField(record, "steering"),
          followUp: stringsField(record, "followUp"),
        });
        return [];
      case "thinking_level_changed": {
        const level = stringField(record, "level");
        if (level !== undefined) this.#timeline.setState({ reasoning: level });
        return [];
      }
      case "compaction_start":
        this.#notice("Compacting the conversation…");
        return [];
      case "compaction_end":
        this.#compactionEnd(record);
        return [];
      case "auto_retry_start":
        this.#notice(
          `Retrying after an error (attempt ${numberField(record, "attempt") ?? 1} of ${
            numberField(record, "maxAttempts") ?? 1
          }): ${stringField(record, "errorMessage") ?? "unknown error"}`,
        );
        return [];
      case "auto_retry_end":
        if (booleanField(record, "success") === false) {
          this.#error(`The retry failed: ${stringField(record, "finalError") ?? "unknown error"}`);
          this.#timeline.setState({ turn: "error" });
          return [{ type: "status", state: "error" }];
        }
        return [];
      case "extension_error":
        this.#notice(
          `Extension ${stringField(record, "extensionPath") ?? "(unknown)"} failed on ${
            stringField(record, "event") ?? "an event"
          }: ${stringField(record, "error") ?? "unknown error"}`,
        );
        return [];
      default:
        // turn_start/turn_end/agent_end are covered by agent_settled; session entries, thinking
        // levels of providers and the RPC bash stream have no item in this contract.
        return [];
    }
  }

  /**
   * The session's history as items, oldest first. Runs on every (re)start before events stream, so
   * the chat is rebuilt from pi's own session after a server restart (the transcript is pi's, not
   * Corral's).
   */
  loadHistory(messages: readonly PiRecord[]): void {
    for (const [index, message] of messages.entries()) {
      const prefix = `h-${index}`;
      const role = stringField(message, "role");
      if (role === "user") {
        const text = contentText(message["content"]);
        if (text !== "") this.#timeline.put({ kind: "user-message", id: prefix, text });
      } else if (role === "assistant") {
        this.#historyAssistant(prefix, message);
      } else if (role === "toolResult") {
        this.#toolResult(message, "history");
      }
      // system messages carry the prompt and tools, not conversation; bashExecution is RPC-only.
    }
    this.#live = undefined;
  }

  /** What `get_state`, `get_available_models` and the level list say about the session's model. */
  loadModelState(state: PiRecord, models: readonly PiRecord[], levels: readonly string[]): void {
    const current = objectField(state, "model");
    this.#timeline.setState({
      model: current === undefined ? null : modelOf(current),
      models: models.map(modelOf),
      reasoning: stringField(state, "thinkingLevel") ?? null,
      reasoningLevels: [...levels],
    });
  }

  /**
   * Answers a pending request. Returns the `extension_ui_response` to write to pi, or undefined
   * when the item is not a request that is still waiting.
   */
  respond(itemId: string, value: ChatAnswer): PiRecord | undefined {
    const pending = this.#dialogs.get(itemId);
    const item = this.#timeline.item(itemId);
    if (pending === undefined || item === undefined || item.kind !== "user-request")
      return undefined;
    this.#dialogs.delete(itemId);
    this.#timeline.put({ ...item, status: "answered", answer: value });
    const response: Record<string, unknown> = {
      type: "extension_ui_response",
      id: pending.piRequestId,
    };
    if (value === null) response["cancelled"] = true;
    else if (pending.request === "confirm") response["confirmed"] = value === true;
    else response["value"] = value;
    return response;
  }

  /** Stops waiting for a request: pi's answer never came, or the run is over. */
  expire(itemId: string): { item: ChatUserRequest; piRequestId: string } | undefined {
    const pending = this.#dialogs.get(itemId);
    const item = this.#timeline.item(itemId);
    this.#dialogs.delete(itemId);
    if (pending === undefined || item === undefined || item.kind !== "user-request")
      return undefined;
    const expired: ChatUserRequest = { ...item, status: "expired" };
    this.#timeline.put(expired);
    return { item: expired, piRequestId: pending.piRequestId };
  }

  /** Expires every pending request; pi is blocked on one at most, but none may outlive the run. */
  expireAll(): string[] {
    const piRequestIds: string[] = [];
    // Deleting the current key while iterating a Map is safe; the ids are the ones still there.
    for (const itemId of this.#dialogs.keys()) {
      const expired = this.expire(itemId);
      if (expired !== undefined) piRequestIds.push(expired.piRequestId);
    }
    return piRequestIds;
  }

  /**
   * Ends the frontend's part of the chat: no item is left pretending to stream and an error says
   * why. The record is already in the timeline, so a client that was watching has it.
   */
  fail(reason: string): void {
    this.expireAll();
    this.#stopStreaming();
    this.#error(reason);
    this.#timeline.setState({ turn: "error" });
  }

  /** `agent_settled`: pi will not continue by itself. */
  #settled(aborted: boolean): PiAction[] {
    const actions: PiAction[] = [];
    for (const itemId of this.#dialogs.keys()) {
      this.expire(itemId);
      actions.push({ type: "dialog-closed", itemId });
    }
    this.#stopStreaming();
    this.#timeline.setState({ turn: aborted ? "aborted" : "settled" });
    actions.push({ type: "status", state: aborted ? "idle" : "done" });
    return actions;
  }

  #messageStart(record: PiRecord): void {
    const message = objectField(record, "message");
    if (message === undefined || stringField(message, "role") !== "assistant") return;
    this.#live = { blocks: new Map() };
  }

  #messageUpdate(record: PiRecord): PiAction[] {
    const update = objectField(record, "assistantMessageEvent");
    if (update === undefined) return [];
    const type = typeOf(update);
    const index = numberField(update, "contentIndex") ?? 0;
    const live = (this.#live ??= { blocks: new Map() });
    switch (type) {
      case "text_start":
        this.#textBlock(live, index);
        return [];
      case "text_delta": {
        const delta = stringField(update, "delta") ?? "";
        if (delta === "" && !live.blocks.has(index)) return [];
        const block = this.#textBlock(live, index);
        this.#timeline.appendText(block.itemId, delta);
        return [];
      }
      case "text_end": {
        const block = this.#textBlock(live, index);
        this.#replaceText(this.#timeline.item(block.itemId), stringField(update, "content") ?? "");
        return [];
      }
      case "thinking_start":
        this.#thinkingBlock(live, index);
        return [];
      case "thinking_delta": {
        const delta = stringField(update, "delta") ?? "";
        if (delta === "" && !live.blocks.has(index)) return [];
        const block = this.#thinkingBlock(live, index);
        this.#timeline.appendText(block.itemId, delta);
        return [];
      }
      case "thinking_end": {
        const block = this.#thinkingBlock(live, index);
        this.#replaceText(this.#timeline.item(block.itemId), stringField(update, "content") ?? "");
        return [];
      }
      case "toolcall_start":
        this.#toolBlock(live, index, update);
        return [];
      case "toolcall_delta": {
        const block = live.blocks.get(index);
        const item = block === undefined ? undefined : this.#timeline.item(block.itemId);
        if (item === undefined || item.kind !== "tool-call") return [];
        this.#timeline.put({
          ...item,
          arguments: item.arguments + (stringField(update, "delta") ?? ""),
        });
        return [];
      }
      case "toolcall_end":
        this.#toolBlock(live, index, update, objectField(update, "toolCall"));
        return [];
      case "error": {
        const reason =
          stringField(update, "reason") ??
          stringField(update, "error") ??
          "The model call failed without a reason.";
        this.#error(reason);
        this.#timeline.setState({ turn: "error" });
        return [{ type: "status", state: "error" }];
      }
      default:
        return [];
    }
  }

  #messageEnd(record: PiRecord): PiAction[] {
    const message = objectField(record, "message");
    if (message === undefined) return [];
    const role = stringField(message, "role");
    if (role === "toolResult") {
      this.#toolResult(message, "live");
      return [];
    }
    if (role !== "assistant") return [];
    const live = (this.#live ??= { blocks: new Map() });
    const content = arrayField(message, "content") ?? [];
    for (const [index, block] of content.entries()) {
      if (!isRecord(block)) continue;
      const typed = block;
      switch (typeOf(typed)) {
        case "text": {
          const existing = this.#textBlock(live, index);
          this.#replaceText(
            this.#timeline.item(existing.itemId),
            stringField(typed, "text") ?? "",
            false,
          );
          break;
        }
        case "thinking": {
          const existing = this.#thinkingBlock(live, index);
          this.#replaceText(
            this.#timeline.item(existing.itemId),
            stringField(typed, "thinking") ?? "",
            false,
          );
          break;
        }
        case "toolCall":
          this.#toolBlock(live, index, typed, typed);
          break;
        default:
          break;
      }
    }
    this.#live = undefined;
    const actions: PiAction[] = [];
    const stopReason = stringField(message, "stopReason");
    if (stopReason === "error") {
      this.#error(stringField(message, "errorMessage") ?? "The model call failed.");
      this.#timeline.setState({ turn: "error" });
      actions.push({ type: "status", state: "error" });
    } else if (stopReason === "aborted") {
      this.#timeline.setState({ turn: "aborted" });
    }
    this.#stopStreaming();
    return actions;
  }

  #toolExecution(record: PiRecord): void {
    const toolCallId = stringField(record, "toolCallId");
    const toolName = stringField(record, "toolName");
    if (toolCallId === undefined || toolName === undefined) return;
    const itemId = `tool-${toolCallId}`;
    const existing = this.#timeline.item(itemId);
    const args = objectField(record, "args");
    if (args !== undefined) this.#rememberToolPath(toolCallId, args);
    const type = typeOf(record);
    if (type === "tool_execution_start") {
      const item: ChatToolCall = {
        kind: "tool-call",
        id: itemId,
        name: toolName,
        arguments: existing?.kind === "tool-call" ? existing.arguments : JSON.stringify(args ?? {}),
        status: "running",
        output: existing?.kind === "tool-call" ? existing.output : null,
        diff: existing?.kind === "tool-call" ? existing.diff : null,
      };
      this.#timeline.put(item);
      return;
    }
    const result = objectField(
      record,
      type === "tool_execution_update" ? "partialResult" : "result",
    );
    const item: ChatToolCall = {
      kind: "tool-call",
      id: itemId,
      name: toolName,
      arguments: existing?.kind === "tool-call" ? existing.arguments : JSON.stringify(args ?? {}),
      status:
        type === "tool_execution_update"
          ? "running"
          : booleanField(record, "isError")
            ? "error"
            : "done",
      output: result === undefined ? null : contentText(result["content"]) || null,
      diff: result === undefined ? null : this.#diffOf(toolCallId, objectField(result, "details")),
    };
    this.#timeline.put(item);
  }

  #toolResult(message: PiRecord, source: "live" | "history"): void {
    const toolCallId = stringField(message, "toolCallId") ?? "";
    const toolName = stringField(message, "toolName") ?? "tool";
    if (toolCallId === "") return;
    const itemId = `tool-${toolCallId}`;
    const existing = this.#timeline.item(itemId);
    const output = contentText(message["content"]);
    const details = objectField(message, "details");
    const args = objectField(message, "args");
    if (args !== undefined) this.#rememberToolPath(toolCallId, args);
    this.#timeline.put({
      kind: "tool-call",
      id: itemId,
      name: existing?.kind === "tool-call" ? existing.name : toolName,
      arguments: existing?.kind === "tool-call" ? existing.arguments : "",
      status: booleanField(message, "isError") === true ? "error" : "done",
      output: output === "" ? null : output,
      diff: this.#diffOf(toolCallId, details),
    });
    if (source === "history") this.#toolPaths.delete(toolCallId);
  }

  #historyAssistant(prefix: string, message: PiRecord): void {
    const content = arrayField(message, "content") ?? [];
    for (const [index, block] of content.entries()) {
      if (!isRecord(block)) continue;
      const typed = block;
      const id = `${prefix}-c${index}`;
      switch (typeOf(typed)) {
        case "text":
          this.#timeline.put({
            kind: "assistant-message",
            id,
            text: stringField(typed, "text") ?? "",
            streaming: false,
          });
          break;
        case "thinking":
          this.#timeline.put({
            kind: "reasoning",
            id,
            text: stringField(typed, "thinking") ?? "",
            streaming: false,
          });
          break;
        case "toolCall": {
          const toolCallId = stringField(typed, "id") ?? id;
          const args = objectField(typed, "arguments");
          if (args !== undefined) this.#rememberToolPath(toolCallId, args);
          this.#timeline.put({
            kind: "tool-call",
            id: `tool-${toolCallId}`,
            name: stringField(typed, "name") ?? "tool",
            arguments: JSON.stringify(args ?? {}),
            status: "running",
            output: null,
            diff: null,
          });
          break;
        }
        default:
          break;
      }
    }
    if (stringField(message, "stopReason") === "error") {
      this.#error(stringField(message, "errorMessage") ?? "The model call failed.");
    }
  }

  #extensionRequest(record: PiRecord): PiAction[] {
    const method = stringField(record, "method") ?? "";
    const piRequestId = stringField(record, "id") ?? "";
    if (method === "notify") {
      const message = stringField(record, "message");
      if (message !== undefined) this.#notice(message);
      return [];
    }
    const request = DIALOG_METHODS[method];
    if (request === undefined || piRequestId === "") return [];
    const title = stringField(record, "title") ?? "";
    const timeout = numberField(record, "timeout");
    const expiresAt =
      this.#now() +
      (timeout === undefined ? this.#dialogTimeoutMs : Math.min(timeout, this.#dialogTimeoutMs));
    const id = `request-${piRequestId}`;
    this.#timeline.put({
      kind: "user-request",
      id,
      request,
      title,
      body: stringField(record, "message") ?? null,
      options: stringsField(record, "options").map((option) => ({ value: option, label: option })),
      placeholder: stringField(record, "placeholder") ?? null,
      prefill: stringField(record, "prefill") ?? null,
      expiresAt,
      status: "pending",
    });
    this.#dialogs.set(id, { piRequestId, request });
    return [
      { type: "dialog-opened", itemId: id, piRequestId, expiresAt },
      { type: "status", state: "blocked", kind: "question", message: title },
    ];
  }

  #compactionEnd(record: PiRecord): void {
    const error = stringField(record, "errorMessage");
    if (error !== undefined) {
      this.#error(`Compaction failed: ${error}`);
      return;
    }
    const result = objectField(record, "result");
    if (result !== undefined) this.#notice("Compacted the conversation.");
  }

  #textBlock(live: LiveAssistant, index: number): LiveBlock {
    const existing = live.blocks.get(index);
    if (existing !== undefined && existing.kind === "text") return existing;
    const block: LiveBlock = { itemId: `text-${(this.#nextId += 1)}`, kind: "text" };
    live.blocks.set(index, block);
    this.#timeline.put({ kind: "assistant-message", id: block.itemId, text: "", streaming: true });
    return block;
  }

  #thinkingBlock(live: LiveAssistant, index: number): LiveBlock {
    const existing = live.blocks.get(index);
    if (existing !== undefined && existing.kind === "thinking") return existing;
    const block: LiveBlock = { itemId: `thinking-${(this.#nextId += 1)}`, kind: "thinking" };
    live.blocks.set(index, block);
    this.#timeline.put({ kind: "reasoning", id: block.itemId, text: "", streaming: true });
    return block;
  }

  #toolBlock(live: LiveAssistant, index: number, call: PiRecord, complete?: PiRecord): void {
    const toolCallId = stringField(call, "id") ?? stringField(complete ?? {}, "id");
    const name = stringField(call, "toolName") ?? stringField(complete ?? {}, "name");
    if (toolCallId === undefined || name === undefined) return;
    const itemId = `tool-${toolCallId}`;
    const block = live.blocks.get(index);
    if (block === undefined) {
      live.blocks.set(index, { itemId, kind: "tool" });
    }
    const args = complete === undefined ? undefined : objectField(complete, "arguments");
    if (args !== undefined) this.#rememberToolPath(toolCallId, args);
    // The result may already have arrived (tool_execution_end before the message's final content);
    // repeating the call must not take the output or the diff away.
    const current = this.#timeline.item(itemId);
    const result = current?.kind === "tool-call" ? current : undefined;
    this.#timeline.put({
      kind: "tool-call",
      id: itemId,
      name,
      arguments: args === undefined ? (result?.arguments ?? "") : JSON.stringify(args),
      status: result?.status ?? "running",
      output: result?.output ?? null,
      diff: result?.diff ?? null,
    });
  }

  #replaceText(item: ChatItem | undefined, text: string, streaming = true): void {
    if (item === undefined) return;
    if (item.kind === "assistant-message" || item.kind === "reasoning") {
      this.#timeline.put({ ...item, text, streaming });
    }
  }

  #rememberToolPath(toolCallId: string, args: PiRecord): void {
    const path = stringField(args, "path");
    if (path !== undefined) this.#toolPaths.set(toolCallId, path);
  }

  /**
   * The unified diff a tool result carries, when it changed a file. pi's `edit` puts the compact
   * diff in `details.diff` and a unified patch (`---`/`+++`, hunks) in `details.patch`; the
   * contract's `ChatDiff` is the latter, so a client's diff renderer gets what it expects.
   */
  #diffOf(toolCallId: string, details: PiRecord | undefined): ChatDiff | null {
    const patch = details === undefined ? undefined : stringField(details, "patch");
    if (patch === undefined || patch === "") return null;
    return { path: this.#toolPaths.get(toolCallId) ?? null, text: patch };
  }

  #stopStreaming(): void {
    for (const item of this.#timeline.snapshot().items) {
      if ((item.kind === "assistant-message" || item.kind === "reasoning") && item.streaming) {
        this.#timeline.put({ ...item, streaming: false });
      }
    }
    this.#live = undefined;
  }

  #notice(text: string): void {
    this.#timeline.put({ kind: "notice", id: `notice-${(this.#nextId += 1)}`, text });
  }

  #error(text: string): void {
    this.#timeline.put({ kind: "error", id: `error-${(this.#nextId += 1)}`, text });
  }
}

/** pi's model object as the chat contract's model entry. */
function modelOf(model: PiRecord): ChatModel {
  const id = stringField(model, "id") ?? "";
  return {
    provider: stringField(model, "provider") ?? null,
    id,
    name: stringField(model, "name") ?? id,
  };
}

/** `recordsField` is used for history and model lists; exported for the driver's own reads. */
export { recordsField };
