import type { ChatAnswer, ChatModelRef } from "@corral/protocol/chat";
import type { AgentStatus, ChatSendMode } from "@corral/protocol/rpc";
import { WebSocket } from "ws";
import { codexChatSupport } from "../agents/codex-version.ts";
import {
  ChatModelUnsupportedError,
  ChatReasoningUnsupportedError,
  ChatRequestUnknownError,
  messageOf,
} from "./chat-errors.ts";
import type {
  ChatDriver,
  ChatDriverLaunch,
  ChatDriverRegistration,
  ChatLaunchFacts,
  ChatTimeouts,
} from "./chat-driver.ts";
import { CodexProjection, type CodexAction } from "./codex-projection.ts";
import type { ChatTimeline } from "./timeline.ts";

/** What the Codex chat frontend is started with: the resolved launch and the deadlines. */
export interface CodexDriverRequest extends ChatDriverLaunch, ChatTimeouts {}

/** How long one JSON-RPC request may take; the app-server is local, so this is generous. */
const REQUEST_TIMEOUT_MS = 20_000;
/** A conversation the app-server forgot (no rollout on disk) is started again under a new id. */
const NO_ROLLOUT = /no rollout found/i;

/**
 * One Codex chat session: a JSON-RPC client of the `codex app-server` the session service started
 * for this session (`codex-server.ts`), over its unix socket. The driver never starts a process of
 * its own — the session's terminal view is another client of the same app-server with
 * `--remote unix://…`, which is what the C3 probe measured as `both-live`.
 *
 * - **Measured transport.** `codex app-server --listen unix://PATH` is a WebSocket endpoint, not a
 *   newline JSON-RPC stream (`--stdio` is the newline one). The handshake and the frames come from
 *   `ws`; the messages are the v2 JSON-RPC methods.
 * - **The thread id is the server's.** `thread/start` takes no id (checked in the 0.166.0 schema),
 *   so the driver reports the id it gets through `onAgentSessionId` and the session service stores
 *   it in `Session.agentSessionId`. A rebuild is `thread/resume` (which also subscribes this
 *   connection to the thread's events) plus `thread/read` when the resume carried no turns.
 *   Because one app-server serves exactly one session, a thread the app-server already holds but
 *   the session row has not learned yet — the terminal started it — is adopted from `thread/list`.
 * - **The prompt is sent only into an empty conversation.** The rebuilt transcript decides, not a
 *   flag on the session row (C1's P0): a resume never repeats the task prompt.
 * - **One prompt writer.** While a turn runs, `chat.send` with `prompt` is refused with one visible
 *   error item and nothing is sent, and `steer` maps to `turn/steer` (measured live). Follow-up is
 *   declared off — `thread/queue/add` is behind the app-server's experimental capability — so the
 *   composer hides it. Turns the terminal starts arrive as the same notifications, so the chat
 *   shows them live.
 * - **Approvals go to every client.** The app-server sends `item/…/requestApproval` as a JSON-RPC
 *   request to each attached frontend (measured: both clients saw the same request and a
 *   `serverRequest/resolved` once one answered). The first answer wins; when it came from the
 *   terminal, `serverRequest/resolved` marks the chat's item resolved instead of leaving it
 *   pending. No approval flag or sandbox bypass is ever passed.
 * - The version is gated (`codexChatSupport`): an executable that is not 0.166.0 gets a sentence
 *   as its exit reason and no chat frontend.
 */
export class CodexDriver implements ChatDriver {
  readonly timeline: ChatTimeline;
  readonly #request: CodexDriverRequest;
  readonly #projection: CodexProjection;
  readonly #pending = new Map<
    number,
    { method: string; resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  readonly #dialogTimers = new Map<string, NodeJS.Timeout>();
  #socket: WebSocket | undefined;
  #nextId = 1;
  #threadId: string | null;
  #readyTimer: NodeJS.Timeout | undefined;
  #closed = false;
  #stopping = false;

  constructor(request: CodexDriverRequest) {
    this.#request = request;
    this.timeline = request.timeline;
    this.#threadId = request.agentSessionId;
    this.#projection = new CodexProjection(this.timeline, {
      now: () => Date.now(),
      dialogTimeoutMs: request.dialogTimeoutMs,
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  get sessionId(): string {
    return this.#request.sessionId;
  }

  get state() {
    return this.timeline.state;
  }

  /** Connects to the session's app-server and opens the thread. Never throws: failure is `onExit`. */
  start(): void {
    if (this.#request.socket === undefined) {
      this.#finish("the codex chat needs the app-server Corral starts; none was passed");
      return;
    }
    this.#readyTimer = setTimeout(
      () => this.#finish(`codex did not answer within ${seconds(this.#request.readyTimeoutMs)}`),
      Math.max(1, this.#request.readyTimeoutMs),
    );
    void this.#run();
  }

  /** Stops the client. The app-server is the session's, so the pool stops it when the last leg goes. */
  async stop(): Promise<void> {
    if (this.#closed) return;
    this.#stopping = true;
    this.#clearTimers();
    for (const itemId of this.#projection.pendingRequests()) this.#projection.expire(itemId);
    this.#failPending(new Error("the codex chat frontend stopped"));
    this.#socket?.close();
    this.#finish(null);
  }

  send(text: string, mode: ChatSendMode): string {
    if (mode === "prompt" && this.timeline.state.turn === "working") {
      // The client offers steer and follow-up while a turn runs; a prompt would be a second
      // writer on the same turn, so it is refused visibly and nothing is sent.
      const refused = `error:send:${this.#nextId}`;
      this.timeline.put({
        kind: "error",
        id: refused,
        text: "a turn is running in this session; steer it or queue a follow-up instead",
      });
      return refused;
    }
    const running = this.timeline.state.turn === "working";
    const refusedId = `error:send:${this.#nextId}`;
    // Measured: `thread/queue/add` needs the app-server's `experimentalApi` capability, which this
    // driver does not opt into for one call; the record declares `followUp: false` and the composer
    // hides the mode. A follow-up that arrives anyway is refused visibly and **not** added as a sent
    // message, so the transcript never shows words that never left the client.
    if (mode === "follow-up" && running) {
      this.timeline.put({
        kind: "error",
        id: refusedId,
        text: "codex does not queue follow-ups in this build; steer the running turn or wait for it to finish",
      });
      return refusedId;
    }
    const itemId = `user:${this.#nextId}:${Date.now()}`;
    this.#projection.userMessage(text, itemId);
    const turnId = this.#projection.activeTurnId;
    const input = [{ type: "text", text }];
    const call =
      mode === "steer" && running && turnId !== undefined
        ? this.#call("turn/steer", {
            threadId: this.#thread(),
            expectedTurnId: turnId,
            input,
            clientUserMessageId: itemId,
          })
        : this.#call("turn/start", {
            threadId: this.#thread(),
            input,
            clientUserMessageId: itemId,
          });
    void call.catch((error: unknown) => {
      this.timeline.put({
        kind: "error",
        id: `error:send:${itemId}`,
        text: `codex did not accept the message: ${messageOf(error)}`,
      });
    });
    return itemId;
  }

  /** Interrupts the running turn; a pending approval can no longer be answered. */
  async abort(): Promise<void> {
    for (const itemId of this.#projection.pendingRequests()) {
      this.#projection.expire(itemId);
      this.#clearDialogTimer(itemId);
    }
    const turnId = this.#projection.activeTurnId;
    if (turnId === undefined) return;
    try {
      await this.#call("turn/interrupt", { threadId: this.#thread(), turnId });
    } catch (error) {
      if (this.#closed) return;
      this.timeline.put({
        kind: "error",
        id: `error:abort:${Date.now()}`,
        text: `codex did not interrupt the turn: ${messageOf(error)}`,
      });
    }
  }

  /**
   * Answers an approval. The first answer wins: when the terminal already answered it, the item
   * was resolved by `serverRequest/resolved` and this throws instead of sending a second answer.
   */
  respond(itemId: string, value: ChatAnswer): void {
    const pending = this.#projection.request(itemId);
    if (pending === undefined) throw new ChatRequestUnknownError(itemId);
    const decision = decisionFor(pending.options, value);
    // Only a decision the server offered is sent: a value this request does not carry would be a
    // provider error the user cannot act on. The item stays pending, so it can still be answered.
    if (decision === undefined) throw new ChatRequestUnknownError(itemId);
    const request = this.#projection.answer(itemId, decision);
    if (request === undefined) throw new ChatRequestUnknownError(itemId);
    this.#clearDialogTimer(itemId);
    this.#send({
      jsonrpc: "2.0",
      id: numericId(request.requestId),
      result: { decision },
    });
    this.#report({ state: "working" });
  }

  async setModel(model: ChatModelRef): Promise<void> {
    throw new ChatModelUnsupportedError(
      model,
      "the codex driver does not switch models in this build",
    );
  }

  async setReasoning(level: string): Promise<void> {
    throw new ChatReasoningUnsupportedError(
      level,
      "the codex driver has no reasoning levels in this build",
    );
  }

  async #run(): Promise<void> {
    const support = await codexChatSupport(this.#request.command, this.#request.env);
    if (!support.supported) {
      this.#finish(support.reason);
      return;
    }
    if (this.#stopping || this.#closed) return;
    try {
      await this.#connect();
      await this.#initialize();
      const thread = await this.#openThread();
      if (this.#closed || this.#stopping) return;
      this.#applyModel(thread);
      const actions = this.#projection.loadHistory(arrayOf(thread["turns"]));
      for (const action of actions) this.#apply(action);
      this.#clearReadyTimer();
      if (this.timeline.state.turn === "idle") this.#report({ state: "done" });
      this.#sendPromptIfNeeded();
    } catch (error) {
      if (this.#stopping || this.#closed) return;
      this.#finish(`codex chat could not start: ${messageOf(error)}`);
    }
  }

  /** One WebSocket over the app-server's unix socket; a close before `stop` is a failed frontend. */
  #connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socketPath = this.#request.socket!;
      // Measured: `--listen unix://PATH` speaks WebSocket; `ws` addresses a unix socket as
      // `ws+unix://<path>:<request path>`.
      const socket = new WebSocket(`ws+unix://${socketPath}:/`, {
        handshakeTimeout: Math.max(1, this.#request.readyTimeoutMs),
      });
      this.#socket = socket;
      socket.once("open", () => resolve());
      socket.once("error", (error) => {
        if (!this.#closed && !this.#stopping)
          reject(new Error(`could not reach the codex app-server: ${messageOf(error)}`));
      });
      socket.on("message", (data) => this.#onFrame(rawText(data)));
      socket.once("close", () => {
        if (!this.#closed && !this.#stopping)
          this.#finish("the codex app-server connection closed");
      });
    });
  }

  async #initialize(): Promise<void> {
    await this.#call("initialize", {
      clientInfo: { name: "corral", version: "0.1.0" },
    });
  }

  /**
   * Opens this session's thread: the recorded one, else the one the app-server already holds (the
   * terminal started it and the session row has not learned it yet), else a new one. The id is
   * reported to the session service, because only the server assigns it.
   */
  async #openThread(): Promise<Record<string, unknown>> {
    if (this.#threadId !== null) {
      try {
        const resumed = await this.#call("thread/resume", { threadId: this.#threadId });
        return await this.#withTurns(resumed, this.#threadId);
      } catch (error) {
        if (!NO_ROLLOUT.test(messageOf(error))) throw error;
        // The thread was created but no turn ever wrote it down, so the id is gone. A new
        // conversation under a new id is the only thing the app-server can do.
        this.#threadId = null;
      }
    }
    const adopted = await this.#adoptThread();
    if (adopted !== null) {
      this.#threadId = adopted;
      this.#request.onAgentSessionId?.(adopted);
      const resumed = await this.#call("thread/resume", { threadId: adopted });
      return await this.#withTurns(resumed, adopted);
    }
    const started = await this.#call("thread/start", {
      cwd: this.#request.cwd,
      // The launch's native model and provider, as the terminal's own flags carry them; without
      // them a chat-first session would silently run the app-server's default model.
      ...(this.#request.model == null ? {} : { model: this.#request.model }),
      ...(this.#request.provider == null ? {} : { modelProvider: this.#request.provider }),
    });
    const thread = recordOf(started["thread"]);
    const id = stringOf(thread?.["id"]);
    if (id === undefined) throw new Error("thread/start answered no thread id");
    this.#threadId = id;
    this.#request.onAgentSessionId?.(id);
    return thread ?? {};
  }

  /** The one non-ephemeral thread this app-server holds, when the session row has no id yet. */
  async #adoptThread(): Promise<string | null> {
    let listed: Record<string, unknown>;
    try {
      listed = await this.#call("thread/list", { limit: 20 });
    } catch {
      // An older server without thread/list simply starts a new thread.
      return null;
    }
    const candidates = arrayOf(listed["data"])
      .map(recordOf)
      .filter((thread): thread is Record<string, unknown> => thread !== undefined)
      .filter((thread) => thread["ephemeral"] !== true)
      .filter((thread) => stringOf(thread["id"]) !== undefined);
    if (candidates.length === 0) return null;
    const newest = candidates.toSorted(
      (left, right) => numberOf(right["recencyAt"]) - numberOf(left["recencyAt"]),
    )[0]!;
    return stringOf(newest["id"]) ?? null;
  }

  /** `thread/resume` normally carries the turns; `thread/read` is the fallback that also has them. */
  async #withTurns(
    resumed: Record<string, unknown>,
    threadId: string,
  ): Promise<Record<string, unknown>> {
    const thread = recordOf(resumed["thread"]) ?? {};
    if (arrayOf(thread["turns"]).length > 0 || stringOf(thread["preview"]) === "") return thread;
    try {
      const read = await this.#call("thread/read", { threadId, includeTurns: true });
      return recordOf(read["thread"]) ?? thread;
    } catch {
      return thread;
    }
  }

  #applyModel(thread: Record<string, unknown>): void {
    const id = stringOf(thread["model"]);
    if (id === undefined) return;
    this.#projection.sessionState({ id, provider: stringOf(thread["modelProvider"]) ?? null });
  }

  /**
   * The launch's candidate first prompt, handed over only when the rebuilt conversation has no
   * user message. A restart, a `setView` into chat and a restore all re-run this after the
   * rebuild, so the transcript — not a flag on the session row — decides: a conversation that
   * already has the user's words must never receive the task prompt again (C1's P0).
   */
  #sendPromptIfNeeded(): void {
    const prompt = this.#request.prompt;
    if (prompt === null) return;
    if (this.#projection.hasUserMessage()) return;
    const itemId = `user:${this.#nextId}:${Date.now()}`;
    this.#projection.userMessage(prompt, itemId);
    void this.#call("turn/start", {
      threadId: this.#thread(),
      input: [{ type: "text", text: prompt }],
      clientUserMessageId: itemId,
    }).catch((error: unknown) => {
      this.timeline.put({
        kind: "error",
        id: `error:prompt:${itemId}`,
        text: `codex did not accept the prompt: ${messageOf(error)}`,
      });
    });
  }

  #onFrame(text: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = frame["id"];
    const method = stringOf(frame["method"]);
    const params = recordOf(frame["params"]) ?? {};
    if (method === undefined) {
      // A response to one of our requests.
      if (typeof id !== "number") return;
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      this.#pending.delete(id);
      const error = recordOf(frame["error"]);
      if (error !== undefined) {
        pending.reject(new Error(stringOf(error["message"]) ?? `${pending.method} failed`));
        return;
      }
      pending.resolve(recordOf(frame["result"]) ?? {});
      return;
    }
    const requestId = idOf(id);
    if (requestId !== undefined) {
      // A server-initiated request: an approval. Every client gets it; the first answer wins.
      this.#onServerRequest(requestId, method, params);
      return;
    }
    this.#onNotification(method, params);
  }

  #onServerRequest(requestId: string, method: string, params: Record<string, unknown>): void {
    // A request this client does not render (a permissions profile, an MCP elicitation, a tool
    // call) is left unanswered, not refused: the app-server sends it to every client, the terminal
    // shows it, and the first answer wins — an error from here would beat that dialog.
    if (!isApprovalMethod(method)) return;
    // The v2 approvals name `threadId`; the legacy `applyPatchApproval`/`execCommandApproval` name
    // `conversationId`, so a filter on `threadId` alone silently dropped them.
    const threadId = stringOf(params["threadId"]) ?? stringOf(params["conversationId"]);
    if (this.#threadId !== null && threadId !== undefined && threadId !== this.#threadId) return;
    for (const action of this.#projection.requestApproval(requestId, method, params)) {
      this.#apply(action);
    }
  }

  #onNotification(method: string, params: Record<string, unknown>): void {
    if (this.#closed) return;
    if (method === "thread/started" || method === "thread/closed") return;
    if (method === "serverRequest/resolved" || method === "error") {
      // Both carry a thread: an ephemeral thread the app-server runs for a title must not fail this
      // session, and a request resolved on another thread is not this chat's item.
      const threadId = stringOf(params["threadId"]);
      if (threadId !== undefined && threadId !== this.#threadId) return;
      for (const action of this.#projection.apply(method, params)) this.#apply(action);
      return;
    }
    if (method === "thread/status/changed") {
      if (stringOf(params["threadId"]) !== this.#threadId) return;
      for (const action of this.#projection.apply(method, params)) this.#apply(action);
      return;
    }
    if (this.#threadId !== null && stringOf(params["threadId"]) !== this.#threadId) return;
    for (const action of this.#projection.apply(method, params)) this.#apply(action);
  }

  #apply(action: CodexAction): void {
    switch (action.type) {
      case "status":
        this.#report(action);
        break;
      case "request-opened":
        this.#dialogTimers.set(
          action.itemId,
          setTimeout(
            () => {
              // Corral stops waiting; the app-server's own deadline remains the backstop.
              this.#projection.expire(action.itemId);
              this.#clearDialogTimer(action.itemId);
            },
            Math.max(1, this.#projection.dialogTimeoutMs),
          ).unref(),
        );
        break;
      case "request-closed":
        this.#clearDialogTimer(action.itemId);
        break;
      case "turn-completed":
        for (const itemId of this.#projection.pendingRequests()) {
          this.#projection.expire(itemId);
          this.#clearDialogTimer(itemId);
        }
        break;
    }
  }

  #report(action: { state: AgentStatus["state"]; message?: string; kind?: "question" }): void {
    const status: AgentStatus = {
      state: action.state,
      updatedAt: Date.now(),
      ...(action.kind === undefined ? {} : { kind: action.kind }),
      ...(action.message === undefined ? {} : { message: action.message }),
    };
    this.#request.onStatus(status);
  }

  #call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      this.#pending.set(id, {
        method,
        resolve: (result) => resolve(recordOf(result) ?? {}),
        reject,
      });
      this.#send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        reject(new Error(`${method} did not answer within ${REQUEST_TIMEOUT_MS} ms`));
      }, REQUEST_TIMEOUT_MS).unref?.();
    });
  }

  #send(frame: Record<string, unknown>): void {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(frame));
  }

  #thread(): string {
    const id = this.#threadId;
    if (id === null) throw new Error("the codex session has no thread id");
    return id;
  }

  #finish(reason: string | null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTimers();
    this.#failPending(new Error(reason ?? "the codex chat frontend stopped"));
    try {
      this.#socket?.close();
    } catch {
      // A socket that is already gone is fine.
    }
    this.#request.onExit(reason);
  }

  #failPending(error: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const each of pending) each.reject(error);
  }

  #clearTimers(): void {
    this.#clearReadyTimer();
    for (const timer of this.#dialogTimers.values()) clearTimeout(timer);
    this.#dialogTimers.clear();
  }

  #clearDialogTimer(itemId: string): void {
    const timer = this.#dialogTimers.get(itemId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#dialogTimers.delete(itemId);
  }

  #clearReadyTimer(): void {
    if (this.#readyTimer === undefined) return;
    clearTimeout(this.#readyTimer);
    this.#readyTimer = undefined;
  }
}

/**
 * The decision to send for an answer, or undefined when the request does not offer one. A string
 * must name an option; a boolean and `null` choose the first allow/deny the request offered, so a
 * client that only knows "yes" or "no" cannot send a value the server rejected from the list.
 */
function decisionFor(options: readonly string[], value: ChatAnswer): string | undefined {
  if (typeof value === "string") return options.includes(value) ? value : undefined;
  const allowed = (option: string) => option.startsWith("accept") || option === "approved";
  const denied = (option: string) => option.startsWith("decline") || option === "denied";
  const wanted = value === true ? options.find(allowed) : options.find(denied);
  return wanted;
}

/** Approval requests that become B0 user requests; the legacy two are for `SendUserMessage`. */
function isApprovalMethod(method: string): boolean {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "applyPatchApproval" ||
    method === "execCommandApproval"
  );
}

/** `RequestId` is a string or an integer; our own requests are integers. */
function numericId(requestId: string): string | number {
  return /^-?\d+$/.test(requestId) ? Number(requestId) : requestId;
}

/** The chat argv a launch of this driver would use: the driver is a socket client, so there is none. */
function codexChatArgs(_facts: ChatLaunchFacts): string[] {
  return [];
}

/**
 * The registry entry. `terminalView: "both-live"` is the measured fact (`.e2e/stage-c/c3/probe/`,
 * `design.md` **Terminal and chat**): the TUI is a second client of the same per-session
 * app-server (`codex --remote unix://… resume <thread>`), so opening the other view starts a
 * client instead of stopping this one.
 */
export const codexChatDriver: ChatDriverRegistration = {
  capabilities: {
    steer: true,
    followUp: false,
    approvals: true,
    modelSwitch: false,
    reasoningLevels: false,
    terminalView: "both-live",
  },
  args: codexChatArgs,
  create: (launch) => new CodexDriver(launch),
};

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
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

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/** A server request id is a string or an integer; anything else is not ours to answer. */
function idOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

/** A WebSocket frame is `Buffer | ArrayBuffer | Buffer[]`; the app-server sends UTF-8 JSON text. */
function rawText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  return "";
}
