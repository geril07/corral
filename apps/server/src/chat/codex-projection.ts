import type {
  ChatAnswer,
  ChatDiff,
  ChatRequestOption,
  ChatSessionState,
  ChatToolStatus,
  ChatTurnState,
  ChatUserRequest,
} from "@corral/protocol/chat";
import type { AgentStatus } from "@corral/protocol/rpc";
import type { ChatTimeline } from "./timeline.ts";

/** What the projection asks the driver to do besides writing items. */
export type CodexAction =
  | {
      type: "status";
      state: AgentStatus["state"];
      message?: string;
      kind?: "question";
    }
  | { type: "request-opened"; itemId: string; requestId: string }
  | { type: "request-closed"; itemId: string }
  | { type: "turn-completed"; status: TurnStatus; message?: string };

type TurnStatus = "completed" | "interrupted" | "failed";

/** The subset of the app-server's notifications this driver understands, by `method`. */
export const CODEX_NOTIFICATIONS = [
  "thread/started",
  "thread/closed",
  "thread/status/changed",
  "thread/compacted",
  "turn/started",
  "turn/completed",
  "turn/diff/updated",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "serverRequest/resolved",
  "warning",
  "error",
] as const;

/** One approval the app-server asked for: its JSON-RPC id, and the decision vocabulary it accepts. */
export interface CodexRequest {
  requestId: string;
  itemId: string;
  options: string[];
}

const APPROVAL_OPTIONS: ChatRequestOption[] = [
  { value: "accept", label: "Allow once", description: "Run this one command or change." },
  {
    value: "acceptForSession",
    label: "Allow for this session",
    description: "Stop asking for this command or these files until the session ends.",
  },
  { value: "decline", label: "Deny", description: "Refuse it; the turn continues." },
  { value: "cancel", label: "Deny and stop", description: "Refuse it and interrupt the turn." },
];

const LEGACY_OPTIONS: ChatRequestOption[] = [
  { value: "approved", label: "Allow once", description: "Apply this change." },
  {
    value: "approved_for_session",
    label: "Allow for this session",
    description: "Stop asking for this until the session ends.",
  },
  { value: "denied", label: "Deny", description: "Refuse it; the turn continues." },
  { value: "abort", label: "Deny and stop", description: "Refuse it and stop the turn." },
];

/**
 * The app-server's records projected into the chat contract (`design.md`, decision 14). The
 * driver owns the socket and the lifecycle; this class owns what one notification means, so the
 * same mapping serves a live turn and a rebuilt transcript.
 *
 * Ids: an app-server item id maps to `codex:<id>` unless the item carries a `clientId`, which is
 * the id Corral sent as `clientUserMessageId` — then the optimistic item keeps its own id and the
 * rebuild replaces it instead of duplicating the user's words. An approval is
 * `codex-request:<jsonRpcId>`, because one item can ask twice (a stdin approval after a command).
 */
export class CodexProjection {
  readonly #timeline: ChatTimeline;
  readonly #now: () => number;
  readonly #dialogTimeoutMs: number;
  /** The chat item id for an app-server item id, so a delta before `item/started` still lands. */
  readonly #chatIds = new Map<string, string>();
  /** Streamed text per chat item, so a delta and a final item cannot disagree. */
  readonly #text = new Map<string, string>();
  /** Command output per chat item, replaced whole on every update. */
  readonly #output = new Map<string, string>();
  /** Pending approvals by chat item id. */
  readonly #requests = new Map<string, CodexRequest>();
  /** The whole turn's diff, used when a file change item carries none. */
  #turnDiff: ChatDiff | null = null;
  #turn: ChatTurnState = "idle";
  #activeTurnId: string | undefined;

  constructor(timeline: ChatTimeline, options: { now: () => number; dialogTimeoutMs: number }) {
    this.#timeline = timeline;
    this.#now = options.now;
    this.#dialogTimeoutMs = options.dialogTimeoutMs;
  }

  /** How long the server waits for an approval before it stops waiting; the client's deadline. */
  get dialogTimeoutMs(): number {
    return this.#dialogTimeoutMs;
  }

  /** The turn id the driver must name in `turn/steer` and `turn/interrupt`. */
  get activeTurnId(): string | undefined {
    return this.#activeTurnId;
  }

  get turn(): ChatTurnState {
    return this.#turn;
  }

  /** The pending approval with this chat item id, or undefined. */
  request(itemId: string): CodexRequest | undefined {
    return this.#requests.get(itemId);
  }

  /** Replaces the timeline's session state; `models` is the one model the thread reports. */
  sessionState(model: { id: string; provider: string | null } | null): void {
    const state: Partial<ChatSessionState> =
      model === null
        ? {}
        : {
            model: { provider: model.provider, id: model.id, name: model.id },
            models: [{ provider: model.provider, id: model.id, name: model.id }],
          };
    this.#timeline.setState({ ...state, turn: this.#turn });
  }

  setTurn(turn: ChatTurnState): void {
    this.#turn = turn;
    this.#timeline.setState({ turn });
  }

  /**
   * Adds the user's message before the app-server echoes it. The id travels as
   * `clientUserMessageId`, so the echo replaces this item rather than adding a second one.
   */
  userMessage(text: string, id: string): void {
    this.#timeline.put({ kind: "user-message", id, text });
    this.#text.set(id, text);
  }

  /** A first prompt is sent only when the rebuilt conversation has no user message (C1's rule). */
  hasUserMessage(): boolean {
    return this.#timeline.snapshot().items.some((item) => item.kind === "user-message");
  }

  /**
   * Applies one notification. `method` is the app-server's own name; anything not in
   * `CODEX_NOTIFICATIONS` is ignored, so a newer server cannot break the driver with an addition.
   */
  apply(method: string, params: Record<string, unknown>): CodexAction[] {
    switch (method) {
      case "turn/started": {
        const turn = recordOf(params["turn"]);
        this.#activeTurnId = stringOf(turn?.["id"]);
        this.#turnDiff = null;
        this.setTurn("working");
        return [{ type: "status", state: "working" }];
      }
      case "turn/completed":
        return this.#turnCompleted(recordOf(params["turn"]));
      case "turn/diff/updated": {
        const diff = stringOf(params["diff"]);
        if (diff !== undefined && diff !== "") {
          this.#turnDiff = { path: null, text: diff };
        }
        return [];
      }
      case "item/started":
        return this.#item(recordOf(params["item"]), "started");
      case "item/completed":
        return this.#item(recordOf(params["item"]), "completed");
      case "item/agentMessage/delta": {
        const itemId = stringOf(params["itemId"]);
        const delta = stringOf(params["delta"]);
        if (itemId === undefined || delta === undefined) return [];
        return this.#delta(itemId, delta, "assistant-message");
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const itemId = stringOf(params["itemId"]);
        const delta = stringOf(params["delta"]);
        if (itemId === undefined || delta === undefined) return [];
        return this.#delta(itemId, delta, "reasoning");
      }
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta": {
        const itemId = stringOf(params["itemId"]);
        const delta = stringOf(params["delta"]);
        if (itemId === undefined || delta === undefined) return [];
        return this.#toolOutputDelta(itemId, delta);
      }
      case "serverRequest/resolved": {
        const requestId = requestIdOf(params["requestId"]);
        if (requestId === undefined) return [];
        const itemId = [...this.#requests.entries()].find(
          ([, request]) => request.requestId === requestId,
        )?.[0];
        if (itemId === undefined) return [];
        this.#requests.delete(itemId);
        this.#resolveItem(itemId);
        return [{ type: "request-closed", itemId }];
      }
      case "thread/status/changed": {
        const status = recordOf(params["status"]);
        if (status?.["type"] !== "systemError") return [];
        this.setTurn("error");
        return [{ type: "status", state: "error" }];
      }
      case "error": {
        const error = recordOf(params["error"]);
        const message = stringOf(error?.["message"]) ?? "the codex app-server reported an error";
        if (params["willRetry"] === true) return [];
        this.setTurn("error");
        this.#putError(`codex-error:${this.#now()}`, message);
        return [{ type: "status", state: "error", message }];
      }
      case "thread/compacted":
        this.#notice("codex-notice:compacted", "Codex compacted the conversation.");
        return [];
      default:
        return [];
    }
  }

  /**
   * Records an approval the app-server sent as a JSON-RPC request. `method` picks the vocabulary;
   * the options are the decisions that method accepts as a plain string.
   */
  requestApproval(
    requestId: string,
    method: string,
    params: Record<string, unknown>,
  ): CodexAction[] {
    const legacy = method === "applyPatchApproval" || method === "execCommandApproval";
    const options = legacy ? LEGACY_OPTIONS : APPROVAL_OPTIONS;
    const itemId = `codex-request:${requestId}`;
    const item: ChatUserRequest = {
      kind: "user-request",
      id: itemId,
      request: "select",
      title: approvalTitle(method),
      body: approvalBody(method, params),
      options,
      placeholder: null,
      prefill: null,
      expiresAt: this.#now() + this.#dialogTimeoutMs,
      status: "pending",
    };
    this.#requests.set(itemId, {
      requestId,
      itemId,
      options: options.map((option) => option.value),
    });
    this.#timeline.put(item);
    this.setTurn("working");
    return [
      { type: "request-opened", itemId, requestId },
      // A pending approval blocks the session, and the terminal shows the same dialog.
      { type: "status", state: "blocked", kind: "question" },
    ];
  }

  /**
   * The answer to send, or undefined when this item is not a pending approval. `answer` is a
   * string naming an option, a boolean (accept/deny), or null to dismiss (deny).
   */
  answer(itemId: string, answer: ChatAnswer): CodexRequest | undefined {
    const request = this.#requests.get(itemId);
    if (request === undefined) return undefined;
    this.#requests.delete(itemId);
    const item = this.#timeline.item(itemId);
    if (item?.kind === "user-request") {
      this.#timeline.put({
        ...item,
        status: "answered",
        answer: typeof answer === "string" ? answer : answer === true ? "accept" : "decline",
      });
    }
    return request;
  }

  /** Marks a pending approval expired; the driver only stops waiting, the server is the backstop. */
  expire(itemId: string): void {
    this.#requests.delete(itemId);
    const item = this.#timeline.item(itemId);
    if (item?.kind === "user-request" && item.status === "pending")
      this.#timeline.put({ ...item, status: "expired" });
  }

  /** Every pending approval's item id, for a stop or an abort. */
  pendingRequests(): string[] {
    return [...this.#requests.keys()];
  }

  /**
   * Rebuilds the transcript from `thread/resume`/`thread/read` turns, in order. Items go through
   * the same mapping as live notifications; the last turn's status decides the session's state.
   */
  loadHistory(turns: readonly unknown[]): CodexAction[] {
    const actions: CodexAction[] = [];
    for (const turn of turns) {
      const record = recordOf(turn);
      if (record === undefined) continue;
      const status = stringOf(record["status"]);
      const turnId = stringOf(record["id"]);
      for (const item of arrayOf(record["items"])) {
        actions.push(...this.#item(recordOf(item), "completed"));
      }
      if (status === "inProgress") {
        this.#activeTurnId = turnId;
        this.setTurn("working");
        actions.push({ type: "status", state: "working" });
      } else if (status === "interrupted") {
        this.setTurn("aborted");
        actions.push({ type: "status", state: "idle" });
      } else if (status === "failed") {
        const message = stringOf(recordOf(record["error"])?.["message"]);
        this.setTurn("error");
        actions.push({
          type: "status",
          state: "error",
          ...(message === undefined ? {} : { message }),
        });
      } else {
        this.setTurn("settled");
        actions.push({ type: "status", state: "done" });
      }
    }
    return actions;
  }

  #turnCompleted(turn: Record<string, unknown> | undefined): CodexAction[] {
    const status = stringOf(turn?.["status"]);
    const message = stringOf(recordOf(turn?.["error"])?.["message"]);
    this.#activeTurnId = undefined;
    if (status === "interrupted") {
      this.setTurn("aborted");
      return [
        { type: "turn-completed", status: "interrupted" },
        { type: "status", state: "idle" },
      ];
    }
    if (status === "failed") {
      this.setTurn("error");
      this.#putError(`codex-turn:${this.#now()}`, message ?? "the turn failed");
      return [
        { type: "turn-completed", status: "failed", ...(message === undefined ? {} : { message }) },
        { type: "status", state: "error", ...(message === undefined ? {} : { message }) },
      ];
    }
    this.setTurn("settled");
    return [
      { type: "turn-completed", status: "completed" },
      { type: "status", state: "done" },
    ];
  }

  #item(
    item: Record<string, unknown> | undefined,
    lifecycle: "started" | "completed",
  ): CodexAction[] {
    if (item === undefined) return [];
    const codexId = stringOf(item["id"]);
    const type = stringOf(item["type"]);
    if (codexId === undefined || type === undefined) return [];
    const running = lifecycle === "started";
    switch (type) {
      case "userMessage": {
        const clientId = stringOf(item["clientId"]);
        const id = clientId ?? `codex:${codexId}`;
        this.#chatIds.set(codexId, id);
        const text = userText(item);
        if (text === "") return [];
        this.#timeline.put({ kind: "user-message", id, text });
        this.#text.set(id, text);
        return [];
      }
      case "agentMessage": {
        const id = this.#chatIds.get(codexId) ?? `codex:${codexId}`;
        this.#chatIds.set(codexId, id);
        const text = stringOf(item["text"]) ?? this.#text.get(id) ?? "";
        this.#timeline.put({ kind: "assistant-message", id, text, streaming: running });
        this.#text.set(id, text);
        return [];
      }
      case "reasoning": {
        const id = this.#chatIds.get(codexId) ?? `codex:${codexId}`;
        this.#chatIds.set(codexId, id);
        const text = reasoningText(item) || (this.#text.get(id) ?? "");
        this.#timeline.put({ kind: "reasoning", id, text, streaming: running });
        this.#text.set(id, text);
        return [];
      }
      case "commandExecution":
        return this.#commandExecution(codexId, item, running);
      case "fileChange":
        return this.#fileChange(codexId, item, running);
      case "mcpToolCall": {
        const id = `codex:${codexId}`;
        this.#chatIds.set(codexId, id);
        const server = stringOf(item["server"]) ?? "mcp";
        const tool = stringOf(item["tool"]) ?? "tool";
        this.#timeline.put({
          kind: "tool-call",
          id,
          name: `${server}/${tool}`,
          arguments: jsonText(item["arguments"]),
          status: toolStatus(stringOf(item["status"])),
          output: resultText(recordOf(item["result"])),
          diff: null,
        });
        return [];
      }
      case "webSearch": {
        const id = `codex:${codexId}`;
        this.#chatIds.set(codexId, id);
        this.#timeline.put({
          kind: "tool-call",
          id,
          name: "web search",
          arguments: stringOf(item["query"]) ?? "",
          status: running ? "running" : "done",
          output: null,
          diff: null,
        });
        return [];
      }
      case "enteredReviewMode":
        this.#notice(`codex-notice:${codexId}`, "Codex entered review mode.");
        return [];
      case "exitedReviewMode":
        this.#notice(`codex-notice:${codexId}`, "Codex left review mode.");
        return [];
      case "contextCompaction":
        this.#notice(`codex-notice:${codexId}`, "Codex compacted the conversation.");
        return [];
      default:
        // A newer server's item kind is not a reason to fail the transcript.
        return [];
    }
  }

  #commandExecution(
    codexId: string,
    item: Record<string, unknown>,
    running: boolean,
  ): CodexAction[] {
    const id = `codex:${codexId}`;
    this.#chatIds.set(codexId, id);
    const output = stringOf(item["aggregatedOutput"]) ?? this.#output.get(id) ?? null;
    this.#timeline.put({
      kind: "tool-call",
      id,
      name: "command",
      arguments: stringOf(item["command"]) ?? "",
      status: running ? "running" : toolStatus(stringOf(item["status"])),
      output,
      diff: null,
    });
    return [];
  }

  #fileChange(codexId: string, item: Record<string, unknown>, running: boolean): CodexAction[] {
    const id = `codex:${codexId}`;
    this.#chatIds.set(codexId, id);
    const changes = arrayOf(item["changes"])
      .map(recordOf)
      .filter((change): change is Record<string, unknown> => change !== undefined);
    const texts = changes
      .map((change) => stringOf(change["diff"]))
      .filter((each): each is string => each !== undefined && each !== "");
    const path = changes.length === 1 ? (stringOf(changes[0]?.["path"]) ?? null) : null;
    const diff =
      texts.length > 0
        ? { path, text: texts.join("\n") }
        : running
          ? null
          : (this.#turnDiff ?? null);
    this.#timeline.put({
      kind: "tool-call",
      id,
      name: "file change",
      arguments: changes.map((change) => stringOf(change["path"]) ?? "?").join("\n"),
      status: running ? "running" : toolStatus(stringOf(item["status"])),
      output: null,
      diff,
    });
    return [];
  }

  #delta(codexId: string, delta: string, kind: "assistant-message" | "reasoning"): CodexAction[] {
    const id = this.#chatIds.get(codexId) ?? `codex:${codexId}`;
    this.#chatIds.set(codexId, id);
    const existing = this.#timeline.item(id);
    const text = (this.#text.get(id) ?? "") + delta;
    this.#text.set(id, text);
    if (existing === undefined) {
      this.#timeline.put(
        kind === "reasoning"
          ? { kind, id, text, streaming: true }
          : { kind: "assistant-message", id, text, streaming: true },
      );
    } else if (existing.kind === "assistant-message" || existing.kind === "reasoning") {
      this.#timeline.put({ ...existing, text, streaming: true });
    }
    if (this.#turn !== "working") this.setTurn("working");
    return [];
  }

  #toolOutputDelta(codexId: string, delta: string): CodexAction[] {
    const id = this.#chatIds.get(codexId) ?? `codex:${codexId}`;
    this.#chatIds.set(codexId, id);
    const output = (this.#output.get(id) ?? "") + delta;
    this.#output.set(id, output);
    const existing = this.#timeline.item(id);
    if (existing?.kind === "tool-call")
      this.#timeline.put({ ...existing, output, status: "running" });
    return [];
  }

  #resolveItem(itemId: string): void {
    const item = this.#timeline.item(itemId);
    if (item?.kind !== "user-request" || item.status !== "pending") return;
    // Another frontend answered it (`serverRequest/resolved`). The contract has no "answered
    // elsewhere" value, so it is answered without a recorded answer, which a client renders as
    // resolved and not as the user's own choice.
    this.#timeline.put({ ...item, status: "answered" });
  }

  #notice(id: string, text: string): void {
    this.#timeline.put({ kind: "notice", id, text });
  }

  #putError(id: string, text: string): void {
    this.#timeline.put({ kind: "error", id, text });
  }
}

function approvalTitle(method: string): string {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "execCommandApproval":
      return "Run this command?";
    case "item/fileChange/requestApproval":
    case "applyPatchApproval":
      return "Apply these file changes?";
    default:
      return "Allow this action?";
  }
}

function approvalBody(method: string, params: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const command = stringOf(params["command"]) ?? arrayOf(params["command"]).map(String).join(" ");
  if (command !== undefined && command !== "") parts.push(command);
  const files = params["fileChanges"];
  if (files !== null && typeof files === "object" && !Array.isArray(files))
    parts.push(Object.keys(files).join("\n"));
  const reason = stringOf(params["reason"]);
  if (reason !== undefined && reason !== "") parts.push(reason);
  const cwd = stringOf(params["cwd"]);
  if (cwd !== undefined && cwd !== "" && method !== "applyPatchApproval") parts.push(cwd);
  return parts.length === 0 ? null : parts.join("\n\n");
}

function toolStatus(status: string | undefined): ChatToolStatus {
  switch (status) {
    case "inProgress":
      return "running";
    case "failed":
    case "declined":
      return "error";
    default:
      return "done";
  }
}

function userText(item: Record<string, unknown>): string {
  return arrayOf(item["content"])
    .map(recordOf)
    .filter((content): content is Record<string, unknown> => content !== undefined)
    .map((content) => {
      const text = stringOf(content["text"]);
      if (text !== undefined) return text;
      const type = stringOf(content["type"]);
      return type === undefined ? "" : `[${type}]`;
    })
    .filter((each) => each !== "")
    .join("\n");
}

function reasoningText(item: Record<string, unknown>): string {
  const summary = arrayOf(item["summary"]).filter(
    (each): each is string => typeof each === "string",
  );
  const content = arrayOf(item["content"]).filter(
    (each): each is string => typeof each === "string",
  );
  return [...summary, ...content].join("\n\n");
}

function resultText(result: Record<string, unknown> | undefined): string | null {
  if (result === undefined) return null;
  const content = arrayOf(result["content"]);
  if (content.length === 0) return null;
  return content
    .map(recordOf)
    .filter((each): each is Record<string, unknown> => each !== undefined)
    .map((each) => stringOf(each["text"]) ?? stringOf(each["type"]) ?? "")
    .filter((each) => each !== "")
    .join("\n");
}

function jsonText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "";
  }
}

function requestIdOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
