import type {
  ChatAnswer,
  ChatDiff,
  ChatModel,
  ChatRequestOption,
  ChatToolCall,
  ChatUserRequest,
} from "@corral/protocol/chat";
import { randomBytes } from "node:crypto";
import type { AgentState } from "@corral/protocol/rpc";
import type { ChatTimeline } from "./timeline.ts";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A new id shaped like the ones OpenCode's own client sends (`^msg_`), so the server echoes it. */
export function newOpenCodeMessageId(): string {
  const random = Array.from(randomBytes(26), (byte) => BASE62[byte % BASE62.length]).join("");
  return `msg_${random}`;
}

/** What the driver has to do besides writing the timeline: report, or schedule a request's deadline. */
export type OpenCodeAction =
  | { type: "status"; state: AgentState; kind?: "question"; message?: string }
  | { type: "request-opened"; itemId: string; requestId: string; expiresAt: number }
  | { type: "request-closed"; itemId: string };

export interface OpenCodeProjectionOptions {
  /** Epoch milliseconds; injectable so a test can pin a request's deadline. */
  now: () => number;
  /** How long a permission request waits for an answer before Corral stops waiting. */
  dialogTimeoutMs: number;
}

/** One event of `GET /api/event`, as the server sends it. */
export interface OpenCodeServerEvent {
  id?: string;
  type: string;
  created?: number;
  data?: unknown;
}

interface PendingRequest {
  requestId: string;
}

const PERMISSION_OPTIONS: ChatRequestOption[] = [
  { value: "once", label: "Allow once" },
  {
    value: "always",
    label: "Allow always",
    description: "Answers this request and remembers it for the session",
  },
  { value: "reject", label: "Reject" },
] as const;

/**
 * Turns OpenCode's v2 session stream into the chat contract (`packages/protocol/src/chat.ts`):
 * text and reasoning deltas, tool calls with their result, permission requests as user requests,
 * and the session-level state. Pure apart from the timeline it writes to, so the mapping is tested
 * by feeding recorded events with no server running.
 *
 * Item ids are derived from OpenCode's own message and part ids, so a rebuilt transcript replaces
 * the items already on the timeline instead of duplicating them: the driver hydrates from
 * `GET /api/session/:id/message` after every reconnect, and the same text arrives again as an
 * event. Text appends are therefore overlap-aware — a delta the rebuilt text already ends with
 * appends nothing.
 */
export class OpenCodeProjection {
  readonly #timeline: ChatTimeline;
  readonly #now: () => number;
  readonly #dialogTimeoutMs: number;
  /** The text each streamed item currently ends with, to make a replayed delta idempotent. */
  readonly #texts = new Map<string, string>();
  readonly #requests = new Map<string, PendingRequest>();
  /** Tool input streamed before `session.tool.called` replaces it with the parsed object. */
  readonly #toolArguments = new Map<string, string>();

  constructor(timeline: ChatTimeline, options: OpenCodeProjectionOptions) {
    this.#timeline = timeline;
    this.#now = options.now;
    this.#dialogTimeoutMs = options.dialogTimeoutMs;
  }

  /** Adds the user's message optimistically and returns the id its prompt will echo. */
  userMessage(text: string): { itemId: string; messageId: string } {
    const messageId = newOpenCodeMessageId();
    const itemId = `user:${messageId}`;
    this.#timeline.put({ kind: "user-message", id: itemId, text });
    return { itemId, messageId };
  }

  /** Whether the transcript already holds the user message with this OpenCode id. */
  hasUserMessage(messageId: string): boolean {
    return this.#timeline.item(`user:${messageId}`) !== undefined;
  }

  /** Takes the model and activity the session itself reports (`GET /api/session/:id`). */
  sessionState(info: { model?: unknown; time?: unknown }): void {
    const model = modelOf(info.model);
    if (model !== null) this.#timeline.setState({ model });
    if (busy(info.time)) this.#timeline.setState({ turn: "working" });
  }

  /**
   * Rebuilds the transcript from `GET /api/session/:id/message`. Items keep their OpenCode ids, so
   * the events that arrive afterwards replace or extend exactly what was rebuilt.
   */
  loadHistory(messages: readonly unknown[]): void {
    for (const message of messages) {
      const record = asRecord(message);
      if (record === undefined) continue;
      const id = stringOf(record["id"]);
      if (id === undefined) continue;
      switch (stringOf(record["type"])) {
        case "user":
          this.#timeline.put({
            kind: "user-message",
            id: `user:${id}`,
            text: stringOf(record["text"]) ?? "",
          });
          break;
        case "assistant":
          this.#loadAssistant(id, record);
          break;
        case "idle":
          this.#loadIdle(record);
          break;
        default:
          break;
      }
    }
  }

  /** Applies one event of the session's stream; returns what the driver has to do about it. */
  applyEvent(event: OpenCodeServerEvent): OpenCodeAction[] {
    const data = asRecord(event.data);
    if (data === undefined) return [];
    const actions: OpenCodeAction[] = [];
    switch (event.type) {
      case "session.text.started":
      case "session.text.delta":
      case "session.text.ended":
      case "session.reasoning.started":
      case "session.reasoning.delta":
      case "session.reasoning.ended": {
        const messageId = stringOf(data["assistantMessageID"]);
        if (messageId === undefined) break;
        this.#streamText({
          messageId,
          ordinal: numberOf(data["ordinal"]) ?? 0,
          reasoning: event.type.startsWith("session.reasoning"),
          phase: event.type.endsWith(".started")
            ? "started"
            : event.type.endsWith(".ended")
              ? "ended"
              : "delta",
          delta: stringOf(data["delta"]) ?? "",
          text: stringOf(data["text"]),
        });
        break;
      }
      case "session.tool.input.started":
      case "session.tool.input.delta":
      case "session.tool.input.ended": {
        const messageId = stringOf(data["assistantMessageID"]);
        const toolId = stringOf(data["id"]);
        if (messageId === undefined || toolId === undefined) break;
        this.#toolInput(messageId, toolId, event.type, data);
        break;
      }
      case "session.tool.called":
      case "session.tool.progress":
      case "session.tool.success":
      case "session.tool.failed": {
        const messageId = stringOf(data["assistantMessageID"]);
        const toolId = stringOf(data["id"]);
        if (messageId === undefined || toolId === undefined) break;
        this.#timeline.put(toolEvent(this.#timeline, messageId, toolId, event.type, data));
        break;
      }
      case "session.step.started":
        this.#timeline.setState({ turn: "working" });
        actions.push({ type: "status", state: "working" });
        break;
      case "session.execution.started":
        this.#timeline.setState({ turn: "working" });
        actions.push({ type: "status", state: "working" });
        break;
      case "session.execution.succeeded":
        this.#timeline.setState({ turn: "settled" });
        actions.push({ type: "status", state: "done" });
        break;
      case "session.execution.interrupted":
        this.#timeline.setState({ turn: "aborted" });
        actions.push({ type: "status", state: "idle" });
        break;
      case "session.execution.failed": {
        const message = errorMessage(data["error"]) ?? "the turn failed";
        this.#timeline.put({ kind: "error", id: "error:last", text: message });
        this.#timeline.setState({ turn: "error" });
        actions.push({ type: "status", state: "error", message });
        break;
      }
      case "session.step.failed": {
        const message = errorMessage(data["error"]) ?? "the turn failed";
        const messageId = stringOf(data["assistantMessageID"]);
        this.#timeline.put({
          kind: "error",
          id: messageId === undefined ? "error:last" : `error:${messageId}`,
          text: message,
        });
        actions.push({ type: "status", state: "error", message });
        break;
      }
      case "session.idle": {
        const outcome = stringOf(data["outcome"]);
        if (outcome === "failed") {
          this.#timeline.setState({ turn: "error" });
          actions.push({ type: "status", state: "error" });
        } else if (outcome === "interrupted") {
          this.#timeline.setState({ turn: "aborted" });
          actions.push({ type: "status", state: "idle" });
        } else {
          this.#timeline.setState({ turn: "settled" });
          actions.push({ type: "status", state: "done" });
        }
        break;
      }
      case "permission.asked": {
        const request = this.#request(data);
        if (request !== null) actions.push(request);
        break;
      }
      case "permission.replied": {
        const requestId = stringOf(data["requestID"]);
        if (requestId === undefined) break;
        const closed = this.#closeRequest(requestId);
        if (closed !== null) actions.push({ type: "request-closed", itemId: closed });
        actions.push({ type: "status", state: "working" });
        break;
      }
      default:
        break;
    }
    return actions;
  }

  /** The request an item waits on, for `chat.respond`. Undefined when it is not pending. */
  pending(itemId: string): PendingRequest | undefined {
    return this.#requests.get(itemId);
  }

  /**
   * Records the user's answer on the item and returns what the server expects. The caller sends
   * the reply; the `permission.replied` event closes the item again and changes nothing, because
   * an answered item keeps its answer.
   */
  answer(itemId: string, value: ChatAnswer): { requestId: string; decision: string } | undefined {
    const pending = this.#requests.get(itemId);
    const item = this.#timeline.item(itemId);
    if (pending === undefined || item?.kind !== "user-request" || item.status !== "pending")
      return undefined;
    const decision =
      typeof value === "boolean"
        ? value
          ? "once"
          : "reject"
        : value === "always" || value === "reject"
          ? value
          : value === "once"
            ? "once"
            : "reject";
    this.#requests.delete(itemId);
    this.#timeline.put({ ...item, status: "answered", answer: value });
    return { requestId: pending.requestId, decision };
  }

  /** Every pending request expires: the server's own deadline stays the only backstop left. */
  expireAll(): string[] {
    const expired: string[] = [];
    for (const [itemId] of this.#requests) {
      const item = this.#timeline.item(itemId);
      this.#requests.delete(itemId);
      if (item?.kind !== "user-request") continue;
      this.#timeline.put({ ...item, status: "expired" });
      expired.push(itemId);
    }
    return expired;
  }

  /** The pending requests' item ids. */
  get pendingItems(): string[] {
    return [...this.#requests.keys()];
  }

  /** How long a request waits; the driver's own deadline, not OpenCode's. */
  get dialogTimeoutMs(): number {
    return this.#dialogTimeoutMs;
  }

  #loadAssistant(messageId: string, message: Record<string, unknown>): void {
    const model = modelOf(message["model"]);
    if (model !== null) this.#timeline.setState({ model });
    const content = Array.isArray(message["content"]) ? message["content"] : [];
    let textOrdinal = 0;
    let reasoningOrdinal = 0;
    for (const part of content) {
      const record = asRecord(part);
      if (record === undefined) continue;
      switch (stringOf(record["type"])) {
        case "text": {
          const itemId = textItemId(messageId, textOrdinal++);
          const text = stringOf(record["text"]) ?? "";
          this.#texts.set(itemId, text);
          this.#timeline.put({ kind: "assistant-message", id: itemId, text, streaming: false });
          break;
        }
        case "reasoning": {
          const itemId = reasoningItemId(messageId, reasoningOrdinal++);
          const text = stringOf(record["text"]) ?? "";
          this.#texts.set(itemId, text);
          this.#timeline.put({ kind: "reasoning", id: itemId, text, streaming: false });
          break;
        }
        case "tool": {
          const toolId = stringOf(record["id"]);
          if (toolId === undefined) break;
          const item = toolOf(record);
          this.#timeline.put({ ...item, id: toolItemId(messageId, toolId) });
          break;
        }
        default:
          break;
      }
    }
  }

  #loadIdle(message: Record<string, unknown>): void {
    const outcome = stringOf(message["outcome"]);
    if (outcome === "failed") {
      const error = asRecord(message["error"]);
      this.#timeline.put({
        kind: "error",
        id: "error:last",
        text: stringOf(error?.["message"]) ?? "the turn failed",
      });
      this.#timeline.setState({ turn: "error" });
      return;
    }
    if (outcome === "interrupted") this.#timeline.setState({ turn: "aborted" });
    if (outcome === "succeeded") this.#timeline.setState({ turn: "settled" });
  }

  #streamText(input: {
    messageId: string;
    ordinal: number;
    reasoning: boolean;
    phase: "started" | "delta" | "ended";
    delta: string;
    text: string | undefined;
  }): void {
    const itemId = input.reasoning
      ? reasoningItemId(input.messageId, input.ordinal)
      : textItemId(input.messageId, input.ordinal);
    const kind = input.reasoning ? "reasoning" : "assistant-message";
    const item = (text: string, streaming: boolean) =>
      input.reasoning
        ? ({ kind, id: itemId, text, streaming } as const)
        : ({ kind, id: itemId, text, streaming } as const);
    if (input.phase === "started") {
      if (this.#texts.has(itemId)) return;
      this.#texts.set(itemId, "");
      this.#timeline.put(item("", true));
      return;
    }
    const current = this.#texts.get(itemId) ?? "";
    if (input.phase === "ended") {
      const text = input.text ?? current;
      this.#texts.set(itemId, text);
      this.#timeline.put(item(text, false));
      return;
    }
    if (input.delta === "") return;
    const addition = input.delta.slice(suffixOverlap(current, input.delta));
    if (addition === "") return;
    if (this.#timeline.item(itemId) === undefined) {
      this.#texts.set(itemId, addition);
      this.#timeline.put(item(addition, true));
      return;
    }
    this.#texts.set(itemId, current + addition);
    this.#timeline.appendText(itemId, addition);
  }

  #toolInput(messageId: string, toolId: string, type: string, data: Record<string, unknown>): void {
    const itemId = toolItemId(messageId, toolId);
    const previous = this.#timeline.item(itemId);
    const before = previous?.kind === "tool-call" ? previous : undefined;
    const name = stringOf(data["name"]) ?? before?.name ?? "tool";
    const streamed =
      type === "session.tool.input.ended"
        ? (stringOf(data["text"]) ?? "")
        : (this.#toolArguments.get(itemId) ?? "") + (stringOf(data["delta"]) ?? "");
    this.#toolArguments.set(itemId, streamed);
    this.#timeline.put({
      kind: "tool-call",
      id: itemId,
      name,
      arguments: streamed,
      status: "running",
      output: before?.output ?? null,
      diff: before?.diff ?? null,
    });
  }

  #request(data: Record<string, unknown>): OpenCodeAction | null {
    const requestId = stringOf(data["id"]);
    if (requestId === undefined) return null;
    const itemId = requestItemId(requestId);
    if (this.#requests.has(itemId)) return null;
    const action = stringOf(data["action"]) ?? "permission";
    const resources = stringsOf(data["resources"]);
    const message = stringOf(data["message"]);
    const title = (message ?? `${action} ${resources.join(", ")}`).trim();
    const expiresAt = this.#now() + this.#dialogTimeoutMs;
    const item: ChatUserRequest = {
      kind: "user-request",
      id: itemId,
      request: "select",
      title: title === "" ? "Permission requested" : title,
      body: resources.length === 0 ? null : resources.join(", "),
      options: [...PERMISSION_OPTIONS],
      placeholder: null,
      prefill: null,
      expiresAt,
      status: "pending",
    };
    this.#requests.set(itemId, { requestId });
    this.#timeline.put(item);
    return { type: "request-opened", itemId, requestId, expiresAt };
  }

  /** Marks one request answered; returns its item id, or null when it was not pending. */
  #closeRequest(requestId: string): string | null {
    for (const [itemId, pending] of this.#requests) {
      if (pending.requestId !== requestId) continue;
      this.#requests.delete(itemId);
      const item = this.#timeline.item(itemId);
      if (item?.kind === "user-request" && item.status === "pending") {
        // The answer came from the other frontend (the terminal's own prompt): it resolved,
        // but which option it chose is the server's to know, not this event's.
        this.#timeline.put({ ...item, status: "answered" });
      }
      return itemId;
    }
    return null;
  }
}

function textItemId(messageId: string, ordinal: number): string {
  return `text:${messageId}:${ordinal}`;
}

function reasoningItemId(messageId: string, ordinal: number): string {
  return `reasoning:${messageId}:${ordinal}`;
}

function toolItemId(messageId: string, toolId: string): string {
  return `tool:${messageId}:${toolId}`;
}

function requestItemId(requestId: string): string {
  return `permission:${requestId}`;
}

/** How many characters at the end of `current` are also the start of `delta`. */
function suffixOverlap(current: string, delta: string): number {
  const most = Math.min(current.length, delta.length);
  for (let length = most; length > 0; length -= 1) {
    if (current.endsWith(delta.slice(0, length))) return length;
  }
  return 0;
}

function toolEvent(
  timeline: ChatTimeline,
  messageId: string,
  toolId: string,
  type: string,
  data: Record<string, unknown>,
): ChatToolCall {
  const itemId = toolItemId(messageId, toolId);
  const previous = timeline.item(itemId);
  const before: ChatToolCall =
    previous?.kind === "tool-call"
      ? previous
      : {
          kind: "tool-call",
          id: itemId,
          name: "tool",
          arguments: "",
          status: "running",
          output: null,
          diff: null,
        };
  const name = stringOf(data["name"]) ?? before.name;
  switch (type) {
    case "session.tool.called": {
      const input = data["input"];
      return {
        ...before,
        name,
        id: itemId,
        arguments: input === undefined ? before.arguments : JSON.stringify(input, null, 2),
        status: "running",
      };
    }
    case "session.tool.progress":
      return { ...before, name, id: itemId, status: "running" };
    case "session.tool.success":
    case "session.tool.failed": {
      const failed = type === "session.tool.failed";
      const output = contentText(data["content"]);
      const error = errorMessage(data["error"]);
      return {
        ...before,
        name,
        id: itemId,
        status: failed ? "error" : "done",
        output: failed ? (error ?? output) : output,
        diff: diffOf(data),
      };
    }
    default:
      return { ...before, name, id: itemId };
  }
}

/** The tool part of a message list, as the transcript's tool-call item. */
function toolOf(part: Record<string, unknown>): ChatToolCall {
  const state = asRecord(part["state"]);
  const status = stringOf(state?.["status"]);
  return {
    kind: "tool-call",
    id: "",
    name: stringOf(part["name"]) ?? "tool",
    arguments: state?.["input"] === undefined ? "" : JSON.stringify(state["input"], null, 2),
    status: status === "error" ? "error" : status === "completed" ? "done" : "running",
    output:
      status === "error"
        ? (errorMessage(state?.["error"]) ?? contentText(state?.["content"]))
        : contentText(state?.["content"]),
    diff: state === undefined ? null : diffOf(state),
  };
}

function contentText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const entry of content) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    if (record["type"] === "text") {
      const text = stringOf(record["text"]);
      if (text !== undefined) parts.push(text);
    }
    if (record["type"] === "file") {
      const uri = stringOf(record["uri"]);
      if (uri !== undefined) parts.push(uri);
    }
  }
  return parts.length === 0 ? null : parts.join("\n");
}

/**
 * A unified diff a tool result carries, when it carries one. OpenCode's edit tools report their
 * change under `metadata` (some under `native`); that field is not part of its public schema, so a
 * result without one has no diff rather than a guessed one.
 */
function diffOf(data: Record<string, unknown>): ChatDiff | null {
  for (const source of [asRecord(data["metadata"]), asRecord(data["native"])]) {
    if (source === undefined) continue;
    for (const entry of [source, asRecord(source["filediff"]), asRecord(source["fileDiff"])]) {
      if (entry === undefined) continue;
      const text = stringOf(entry["diff"]) ?? stringOf(entry["patch"]);
      if (text === undefined || text === "") continue;
      return {
        path: stringOf(entry["path"]) ?? stringOf(entry["file"]) ?? null,
        text,
      };
    }
  }
  return null;
}

function modelOf(value: unknown): ChatModel | null {
  const record = asRecord(value);
  if (record === undefined) return null;
  const id = stringOf(record["id"]) ?? stringOf(record["modelID"]);
  if (id === undefined) return null;
  return {
    provider: stringOf(record["providerID"]) ?? stringOf(record["provider"]) ?? null,
    id,
    name: id,
  };
}

function busy(value: unknown): boolean {
  const record = asRecord(value);
  if (record === undefined) return false;
  return (numberOf(record["busy"]) ?? 0) > (numberOf(record["idle"]) ?? 0);
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return stringOf(asRecord(value)?.["message"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
