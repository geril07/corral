import type { ChatAnswer, ChatDiff, ChatModel, ChatRequestOption } from "@corral/protocol/chat";
import type { AgentState } from "@corral/protocol/rpc";
import type {
  ModelInfo,
  PermissionResult,
  PermissionUpdate,
  SDKMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ChatTimeline } from "./timeline.ts";

/**
 * What the driver has to do after a message: run a request deadline, report the agent's status, or
 * move the keyboard (nothing yet). The projection writes the timeline; the driver owns timers and
 * status, exactly as pi's projection/driver split does.
 */
export type ClaudeAction =
  | { type: "status"; state: AgentState; kind?: "question"; message?: string }
  | { type: "request-opened"; itemId: string }
  | { type: "request-closed"; itemId: string };

export interface ClaudeProjectionOptions {
  /** Epoch milliseconds; injectable so a test can pin a deadline. */
  now: () => number;
  /** How long a permission request waits for an answer before the server stops waiting. */
  dialogTimeoutMs: number;
}

/** One `canUseTool` call, as the projection needs it to ask the user. */
export interface ClaudePermissionAsk {
  /** The tool call's id; it names the request item so an answer replaces it in place. */
  toolUseID: string;
  name: string;
  input: Record<string, unknown>;
  /** The prompt sentence Claude rendered, when it sent one. */
  title?: string | undefined;
  /** The longer explanation, when it sent one. */
  description?: string | undefined;
  /** Permission rules an "always allow" answer would add (`canUseTool`'s suggestions). */
  suggestions?: PermissionUpdate[] | undefined;
  /** The permission rules the CLI attached to this ask, for the title fallback. */
  blockedPath?: string | undefined;
}

/** One permission the frontend is waiting on: the item, its promise and its answer's rules. */
interface PendingPermission {
  itemId: string;
  toolUseID: string;
  suggestions: PermissionUpdate[];
  resolve(result: PermissionResult): void;
}

/** One block of the assistant message currently streaming, by its content-block index. */
interface LiveBlock {
  index: number;
  itemId: string;
  kind: "text" | "thinking";
  /** A final assistant frame has already replaced the streamed text with the block's full text. */
  consumed: boolean;
}

/** The value an "always allow" answer needs to widen the rule for the rest of the session. */
export const CLAUDE_ALLOW = "allow";
export const CLAUDE_ALLOW_ALWAYS = "allow-always";
export const CLAUDE_DENY = "deny";

const DENIED_MESSAGE = "The user declined this tool call in Corral.";

/**
 * Turns the Claude Agent SDK's conversation into Corral's chat contract: the transcript
 * (`getSessionMessages`) for the rebuild and the SDK's stream messages for the live turn.
 *
 * Stable ids are the whole game, because an answer and a completion must replace an item rather
 * than add a second one:
 * - a tool call is `tool:<toolUseID>`, its permission request `permission:<toolUseID>`, so the
 *   answer replaces the request in place and the call keeps its own row (a request must not
 *   overwrite the call it is asking about);
 * - streamed text is `text:<message id>:<block index>` and its final assistant frame replaces the
 *   same id, so the client's deltas and the settled text are one item;
 * - history uses the transcript's own message uuid for text and the tool-use id for calls.
 */
export class ClaudeProjection {
  readonly #timeline: ChatTimeline;
  readonly #now: () => number;
  readonly #pending = new Map<string, PendingPermission>();
  readonly #dialogTimeoutMs: number;
  /** The model list, as `supportedModels()` reports it, keyed by the value `setModel` sends. */
  #modelInfo = new Map<string, ModelInfo>();
  /** The content blocks of the assistant message streaming now, in arrival order. */
  #live: LiveBlock[] = [];
  #streamMessageId: string | undefined;
  #nextId = 0;

  constructor(timeline: ChatTimeline, options: ClaudeProjectionOptions) {
    this.#timeline = timeline;
    this.#now = options.now;
    this.#dialogTimeoutMs = Math.max(1, options.dialogTimeoutMs);
  }

  /** The item ids of the permission requests still waiting for an answer, oldest first. */
  get pendingRequests(): string[] {
    return [...this.#pending.keys()];
  }

  /** Appends the user's own message and returns its id, which `chat.send` hands back. */
  userMessage(text: string): string {
    const id = `user:${(this.#nextId += 1)}`;
    this.#timeline.put({ kind: "user-message", id, text });
    return id;
  }

  /**
   * Asks the user to allow or deny one tool call. The returned promise settles with the SDK's
   * `PermissionResult`: `answer` settles it with the user's choice, `expire`/`expireAll` with a
   * denial, so the CLI is never left waiting on a request the server gave up on.
   */
  openPermission(ask: ClaudePermissionAsk): { itemId: string; result: Promise<PermissionResult> } {
    const itemId = permissionItemId(ask.toolUseID);
    let resolve: (result: PermissionResult) => void = noop;
    const result = new Promise<PermissionResult>((settle) => (resolve = settle));
    this.#pending.set(itemId, {
      itemId,
      toolUseID: ask.toolUseID,
      suggestions: ask.suggestions ?? [],
      resolve,
    });
    const options: ChatRequestOption[] = [
      { value: CLAUDE_ALLOW, label: "Allow", description: "Run this tool call once." },
      ...(ask.suggestions !== undefined && ask.suggestions.length > 0
        ? [
            {
              value: CLAUDE_ALLOW_ALWAYS,
              label: "Always allow",
              description: "Run it and stop asking for this tool in this session.",
            },
          ]
        : []),
      { value: CLAUDE_DENY, label: "Deny", description: "Do not run this tool call." },
    ];
    this.#timeline.put({
      kind: "user-request",
      id: itemId,
      request: "select",
      title: ask.title ?? titleOf(ask),
      body: ask.description ?? bodyOf(ask),
      options,
      placeholder: null,
      prefill: null,
      expiresAt: this.#now() + this.#dialogTimeoutMs,
      status: "pending",
    });
    return { itemId, result };
  }

  /**
   * Answers a pending request: resolves its promise once and replaces the item in place. Returns
   * `false` when the item is not waiting for an answer, which is how a second answer is refused.
   */
  answer(itemId: string, value: ChatAnswer): boolean {
    const pending = this.#pending.get(itemId);
    if (pending === undefined) return false;
    this.#pending.delete(itemId);
    const result = resultOf(value, pending);
    pending.resolve(result);
    this.#replaceRequest(pending.itemId, "answered", value);
    return true;
  }

  /** Stops waiting for a request: the CLI gets a denial and the item says it expired. */
  expire(itemId: string): boolean {
    const pending = this.#pending.get(itemId);
    if (pending === undefined) return false;
    this.#pending.delete(itemId);
    pending.resolve(denied("The request timed out in Corral."));
    this.#replaceRequest(pending.itemId, "expired", null);
    return true;
  }

  /** Ends every pending request (a turn settled, an abort, a stop); returns their item ids. */
  expireAll(): string[] {
    const ids = [...this.#pending.keys()];
    for (const itemId of ids) this.expire(itemId);
    return ids;
  }

  #replaceRequest(itemId: string, status: "answered" | "expired", answer: ChatAnswer): void {
    const item = this.#timeline.item(itemId);
    if (item === undefined || item.kind !== "user-request") return;
    this.#timeline.put(
      status === "answered"
        ? { ...item, status, answer: answer ?? null }
        : { ...item, status, answer: null },
    );
  }

  /**
   * Fills the session's model and reasoning state from `supportedModels()` and the CLI's `init`
   * frame. `model` is the wire id the CLI reported (an alias such as `sonnet`, or the resolved id);
   * an entry whose `resolvedModel` matches it is the one the list shows as selected.
   */
  setModels(models: readonly ModelInfo[], model: string | null, effort: string | null): void {
    this.#modelInfo = new Map(models.map((entry) => [entry.value, entry]));
    const entries: ChatModel[] = models.map((entry) => ({
      provider: null,
      id: entry.value,
      name: entry.displayName,
    }));
    // With no model requested, the CLI runs its own default, which the list's first row names.
    const active = activeModelOf(models, model) ?? (model === null ? models[0] : undefined);
    const levels = active === undefined ? [] : (active.supportedEffortLevels ?? []);
    this.#timeline.setState({
      models: entries,
      model:
        active === undefined
          ? model === null
            ? null
            : { provider: null, id: model, name: model }
          : { provider: null, id: active.value, name: active.displayName },
      reasoningLevels: levels,
      reasoning: effort !== null && (levels as readonly string[]).includes(effort) ? effort : null,
    });
  }

  /** The list entry `chat.setModel` names, or undefined when the list does not offer it. */
  model(id: string): ChatModel | undefined {
    const info = this.#modelInfo.get(id);
    if (info !== undefined) return { provider: null, id: info.value, name: info.displayName };
    return undefined;
  }

  /**
   * After `Query.setModel` accepted a model: the model in effect and the levels it takes. A level
   * the new model does not take is cleared rather than displayed as if it still applied.
   */
  activateModel(id: string): void {
    const info = this.#modelInfo.get(id);
    if (info === undefined) return;
    const levels = info.supportedEffortLevels ?? [];
    const current = this.#timeline.state.reasoning;
    this.#timeline.setState({
      model: { provider: null, id: info.value, name: info.displayName },
      reasoningLevels: levels,
      reasoning:
        current !== null && (levels as readonly string[]).includes(current) ? current : null,
    });
  }

  /** Sets the reasoning level after the SDK accepted it. */
  activateReasoning(level: string): void {
    this.#timeline.setState({ reasoning: level });
  }

  /** One SDK message; returns what the driver must do about it. */
  apply(message: SDKMessage): ClaudeAction[] {
    switch (message.type) {
      case "system":
        return this.#system(message);
      case "stream_event":
        this.#streamEvent(message);
        return [];
      case "assistant":
        this.#assistant(message);
        return [];
      case "user":
        // A resumed transcript may be replayed frame by frame; the rebuild already wrote it.
        if ("isReplay" in message && message.isReplay) return [];
        this.#user(message);
        return [];
      case "result":
        return this.#result(message);
      default:
        return [];
    }
  }

  /** The rebuilt transcript from `getSessionMessages`, oldest first. */
  loadHistory(messages: readonly SessionMessage[]): void {
    for (const message of messages) {
      const body = recordOf(message.message);
      if (body === undefined) continue;
      if (message.type === "assistant") this.#historyAssistant(message.uuid, body);
      else if (message.type === "user") this.#historyUser(message.uuid, body);
    }
  }

  #historyAssistant(uuid: string, body: Record<string, unknown>): void {
    const content = body["content"];
    if (typeof content === "string") {
      this.#timeline.put({
        kind: "assistant-message",
        id: `text:${uuid}:0`,
        text: content,
        streaming: false,
      });
      return;
    }
    for (const [index, raw] of (Array.isArray(content) ? content : []).entries()) {
      const block = recordOf(raw);
      if (block === undefined) continue;
      switch (block["type"]) {
        case "text":
          this.#timeline.put({
            kind: "assistant-message",
            id: `text:${uuid}:${index}`,
            text: stringOf(block["text"]) ?? "",
            streaming: false,
          });
          break;
        case "thinking":
          this.#timeline.put({
            kind: "reasoning",
            id: `thinking:${uuid}:${index}`,
            text: stringOf(block["thinking"]) ?? "",
            streaming: false,
          });
          break;
        case "tool_use": {
          const toolUseID = stringOf(block["id"]);
          if (toolUseID === undefined) break;
          this.#putToolCall({
            toolUseID,
            name: stringOf(block["name"]) ?? "tool",
            input: recordOf(block["input"]) ?? {},
          });
          break;
        }
        default:
          break;
      }
    }
  }

  #historyUser(uuid: string, body: Record<string, unknown>): void {
    const content = body["content"];
    if (typeof content === "string") {
      this.#timeline.put({ kind: "user-message", id: `user:${uuid}`, text: content });
      return;
    }
    const blocks = Array.isArray(content) ? content : [];
    let textIndex = 0;
    for (const raw of blocks) {
      const block = recordOf(raw);
      if (block === undefined) continue;
      if (block["type"] === "text") {
        textIndex += 1;
        this.#timeline.put({
          kind: "user-message",
          id: `user:${uuid}:${textIndex}`,
          text: stringOf(block["text"]) ?? "",
        });
      } else if (block["type"] === "tool_result") {
        this.#toolResult(block, null);
      }
    }
  }

  #system(message: Extract<SDKMessage, { type: "system" }>): ClaudeAction[] {
    if (message.subtype === "init") {
      // The frame carries the resolved model and effort; the driver applies them to the state. The
      // turn is the driver's to report: init can arrive after the first prompt is already running.
      return [];
    }
    if (message.subtype === "compact_boundary") {
      this.notice("Compacted the conversation.");
      return [];
    }
    if (message.subtype === "permission_denied") {
      this.notice(message.message);
      return [];
    }
    return [];
  }

  #streamEvent(message: Extract<SDKMessage, { type: "stream_event" }>): void {
    const event = message.event;
    switch (event.type) {
      case "message_start":
        this.#streamMessageId = event.message.id;
        this.#live = [];
        break;
      case "content_block_start":
        this.#blockStart(event.index, event.content_block);
        break;
      case "content_block_delta":
        this.#blockDelta(event.index, event.delta);
        break;
      default:
        break;
    }
  }

  #blockStart(index: number, block: unknown): void {
    const body = recordOf(block);
    if (body === undefined) return;
    if (body["type"] === "text") {
      const itemId = `text:${this.#streamMessageId ?? "stream"}:${index}`;
      this.#live.push({ index, itemId, kind: "text", consumed: false });
      this.#timeline.put({ kind: "assistant-message", id: itemId, text: "", streaming: true });
    } else if (body["type"] === "thinking") {
      const itemId = `thinking:${this.#streamMessageId ?? "stream"}:${index}`;
      this.#live.push({ index, itemId, kind: "thinking", consumed: false });
      this.#timeline.put({ kind: "reasoning", id: itemId, text: "", streaming: true });
    } else if (body["type"] === "tool_use") {
      const toolUseID = stringOf(body["id"]);
      if (toolUseID === undefined) return;
      // The input arrives as `input_json_delta` chunks; the final assistant frame carries the whole
      // object, so the row starts with an empty argument rather than half-parsed JSON.
      this.#putToolCall({
        toolUseID,
        name: stringOf(body["name"]) ?? "tool",
        input: recordOf(body["input"]) ?? {},
      });
    }
  }

  #blockDelta(index: number, delta: unknown): void {
    const body = recordOf(delta);
    if (body === undefined) return;
    if (body["type"] === "text_delta") {
      const block = this.#liveBlock(index);
      if (block !== undefined)
        this.#timeline.appendText(block.itemId, stringOf(body["text"]) ?? "");
    } else if (body["type"] === "thinking_delta") {
      const block = this.#liveBlock(index);
      if (block !== undefined)
        this.#timeline.appendText(block.itemId, stringOf(body["thinking"]) ?? "");
    }
  }

  #liveBlock(index: number): LiveBlock | undefined {
    return this.#live.find((block) => block.index === index);
  }

  #assistant(message: Extract<SDKMessage, { type: "assistant" }>): void {
    const content = message.message.content;
    for (const raw of Array.isArray(content) ? content : []) {
      const block = recordOf(raw);
      if (block === undefined) continue;
      switch (block["type"]) {
        case "text": {
          const live = this.#takeLive("text", message.message.id);
          this.#timeline.put({
            kind: "assistant-message",
            id: live ?? `text:${message.message.id}:${(this.#nextId += 1)}`,
            text: stringOf(block["text"]) ?? "",
            streaming: false,
          });
          break;
        }
        case "thinking": {
          const live = this.#takeLive("thinking", message.message.id);
          this.#timeline.put({
            kind: "reasoning",
            id: live ?? `thinking:${message.message.id}:${(this.#nextId += 1)}`,
            text: stringOf(block["thinking"]) ?? "",
            streaming: false,
          });
          break;
        }
        case "tool_use": {
          const toolUseID = stringOf(block["id"]);
          if (toolUseID === undefined) break;
          this.#putToolCall({
            toolUseID,
            name: stringOf(block["name"]) ?? "tool",
            input: recordOf(block["input"]) ?? {},
          });
          break;
        }
        default:
          break;
      }
    }
  }

  /**
   * The next unconsumed streamed block of this kind, so a final frame replaces its own item. Only
   * the message the blocks belong to may take them: the SDK sends one assistant frame per completed
   * content block, and a frame from another message must not swallow a stream that is still live.
   */
  #takeLive(kind: "text" | "thinking", messageId: string): string | undefined {
    if (this.#streamMessageId !== messageId) return undefined;
    for (const block of this.#live) {
      if (block.kind !== kind || block.consumed) continue;
      block.consumed = true;
      return block.itemId;
    }
    return undefined;
  }

  #user(message: Extract<SDKMessage, { type: "user" }>): void {
    const content = message.message.content;
    for (const raw of Array.isArray(content) ? content : []) {
      const block = recordOf(raw);
      if (block === undefined || block["type"] !== "tool_result") continue;
      this.#toolResult(block, message.tool_use_result ?? null);
    }
  }

  #toolResult(block: Record<string, unknown>, toolUseResult: unknown): void {
    const toolUseID = stringOf(block["tool_use_id"]);
    if (toolUseID === undefined) return;
    const existing = this.#timeline.item(toolItemId(toolUseID));
    const call = existing?.kind === "tool-call" ? existing : undefined;
    const diff = diffOf(toolUseResult) ?? call?.diff ?? null;
    const output = contentText(block["content"]);
    this.#timeline.put({
      kind: "tool-call",
      id: toolItemId(toolUseID),
      name: call?.name ?? "tool",
      arguments: call?.arguments ?? "",
      status: block["is_error"] === true ? "error" : "done",
      output: output === "" ? (call?.output ?? null) : output,
      diff,
    });
  }

  #putToolCall(call: { toolUseID: string; name: string; input: Record<string, unknown> }): void {
    const itemId = toolItemId(call.toolUseID);
    const existing = this.#timeline.item(itemId);
    const current = existing?.kind === "tool-call" ? existing : undefined;
    this.#timeline.put({
      kind: "tool-call",
      id: itemId,
      name: call.name,
      arguments: JSON.stringify(call.input),
      status: current?.status ?? "running",
      output: current?.output ?? null,
      diff: current?.diff ?? null,
    });
  }

  #result(message: Extract<SDKMessage, { type: "result" }>): ClaudeAction[] {
    const actions: ClaudeAction[] = [];
    for (const itemId of this.expireAll()) actions.push({ type: "request-closed", itemId });
    // Any text still streaming has ended, whatever the turn's outcome says next.
    this.#stopStreaming();
    this.#live = [];
    this.#streamMessageId = undefined;
    if (message.subtype === "success" && !message.is_error) {
      this.#timeline.setState({ turn: "settled" });
      actions.push({ type: "status", state: "done" });
      return actions;
    }
    const detail =
      message.subtype === "success"
        ? message.result
        : message.errors
            .map((error) => error.trim())
            .filter(Boolean)
            .join("; ") || `Claude ended the turn (${message.subtype})`;
    this.error(detail);
    this.#timeline.setState({ turn: "error" });
    actions.push({ type: "status", state: "error" });
    return actions;
  }

  /** Marks every streamed item not streaming; a turn that ended must not look mid-word. */
  #stopStreaming(): void {
    for (const item of this.#timeline.snapshot().items) {
      if ((item.kind === "assistant-message" || item.kind === "reasoning") && item.streaming) {
        this.#timeline.put({ ...item, streaming: false });
      }
    }
    this.#live = [];
    this.#streamMessageId = undefined;
  }

  /** Stops every streaming item and records why the frontend is gone. */
  fail(reason: string): void {
    this.expireAll();
    this.#stopStreaming();
    this.error(reason);
    this.#timeline.setState({ turn: "error" });
  }

  /** The frontend stopped in order: nothing may still look mid-word, the turn is left as it was. */
  stopped(): void {
    this.expireAll();
    this.#stopStreaming();
  }

  /** Ends the turn a user asked to stop, so the UI shows an abort rather than a stalled turn. */
  aborted(): void {
    this.expireAll();
    this.#stopStreaming();
    this.#timeline.setState({ turn: "aborted" });
  }

  notice(text: string): void {
    this.#timeline.put({ kind: "notice", id: `notice:${(this.#nextId += 1)}`, text });
  }

  error(text: string): void {
    this.#timeline.put({ kind: "error", id: `error:${(this.#nextId += 1)}`, text });
  }
}

function permissionItemId(toolUseID: string): string {
  return `permission:${toolUseID}`;
}

function toolItemId(toolUseID: string): string {
  return `tool:${toolUseID}`;
}

function activeModelOf(models: readonly ModelInfo[], model: string | null): ModelInfo | undefined {
  if (model === null) return undefined;
  return (
    models.find((entry) => entry.value === model) ??
    models.find((entry) => entry.resolvedModel === model)
  );
}

function titleOf(ask: ClaudePermissionAsk): string {
  return `${ask.name} wants to run`;
}

function bodyOf(ask: ClaudePermissionAsk): string | null {
  if (ask.blockedPath !== undefined) return `It needs access to ${ask.blockedPath}.`;
  return null;
}

function resultOf(value: ChatAnswer, pending: PendingPermission): PermissionResult {
  if (value === CLAUDE_ALLOW || value === true) {
    return {
      behavior: "allow",
      toolUseID: pending.toolUseID,
      decisionClassification: "user_temporary",
    };
  }
  if (value === CLAUDE_ALLOW_ALWAYS) {
    return {
      behavior: "allow",
      toolUseID: pending.toolUseID,
      updatedPermissions: pending.suggestions,
      decisionClassification: "user_permanent",
    };
  }
  return denied(DENIED_MESSAGE);
}

function denied(message: string): PermissionResult {
  return { behavior: "deny", message, decisionClassification: "user_reject" };
}

/** The unified diff a Claude file tool reports: `gitDiff.patch`, else its `structuredPatch`. */
export function diffOf(toolUseResult: unknown): ChatDiff | null {
  const result = recordOf(toolUseResult);
  if (result === undefined) return null;
  const gitDiff = recordOf(result["gitDiff"]);
  const path = stringOf(gitDiff?.["filename"]) ?? stringOf(result["filePath"]) ?? null;
  const patch = stringOf(gitDiff?.["patch"]);
  if (patch !== undefined && patch !== "") return { path, text: patch };
  const hunks = result["structuredPatch"];
  if (!Array.isArray(hunks) || hunks.length === 0) return null;
  return { path, text: unifiedDiff(path, hunks) };
}

/** Builds the `---`/`+++` diff `ChatDiff` promises from Claude's per-file hunk list. */
function unifiedDiff(path: string | null, hunks: readonly unknown[]): string {
  const name = path ?? "file";
  const lines = [`--- a/${name}`, `+++ b/${name}`];
  for (const raw of hunks) {
    const hunk = recordOf(raw);
    if (hunk === undefined) continue;
    const oldStart = numberOf(hunk["oldStart"]) ?? 0;
    const oldLines = numberOf(hunk["oldLines"]) ?? 0;
    const newStart = numberOf(hunk["newStart"]) ?? 0;
    const newLines = numberOf(hunk["newLines"]) ?? 0;
    const body = Array.isArray(hunk["lines"]) ? hunk["lines"].map((line) => String(line)) : [];
    lines.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`, ...body);
  }
  return lines.join("\n");
}

/** A tool result's output as text: a string, or the text blocks of a content array. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((raw) => {
      if (typeof raw === "string") return raw;
      const block = recordOf(raw);
      if (block === undefined) return "";
      if (block["type"] === "text") return stringOf(block["text"]) ?? "";
      return "";
    })
    .filter((part) => part !== "")
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function noop(): void {}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
