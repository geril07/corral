import type { ChatAnswer, ChatModelRef, ChatModelSelection } from "@corral/protocol/chat";
import type { AgentStatus, ChatSendMode } from "@corral/protocol/rpc";
import { WebSocket } from "ws";
import { codexChatSupport } from "../agents/codex-version.ts";
import { readCodexModels } from "../models/codex-models.ts";
import {
  ChatModelUnsupportedError,
  ChatReasoningUnsupportedError,
  ChatRefusalError,
  ChatRequestUnknownError,
  ChatUnavailableError,
  messageOf,
} from "./chat-errors.ts";
import type {
  ChatDriver,
  ChatDriverLaunch,
  ChatDriverRegistration,
  ChatLaunchFacts,
  ChatSendReceipt,
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
 *   error item and nothing is sent, and `steer` maps to `turn/steer` (measured live). A follow-up
 *   is Corral's own queue, not `thread/queue/add` (behind the app-server's experimental
 *   capability). Each queued entry supplies its own model and effort at `turn/start`.
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
  #provider: string | null;
  #prepared: { model: ChatModelRef; level: string | null; effort: string | null } | null = null;
  readonly #turnBoundaries = new Map<string, (outcome: "settled" | "aborted") => void>();
  readonly #earlyTurnBoundaries = new Map<string, "settled" | "aborted">();
  #readyTimer: NodeJS.Timeout | undefined;
  #closed = false;
  #stopping = false;
  #catalogRequest: ReturnType<typeof readCodexModels> | undefined;

  constructor(request: CodexDriverRequest) {
    this.#request = request;
    this.timeline = request.timeline;
    this.#threadId = request.agentSessionId;
    this.#provider = request.provider ?? null;
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

  send(text: string, mode: ChatSendMode, selection?: ChatModelSelection | null): ChatSendReceipt {
    if (mode === "prompt" && this.timeline.state.turn === "working") {
      // The client offers steer and follow-up while a turn runs; a prompt would be a second
      // writer on the same turn, so it is refused visibly and nothing is sent.
      const refused = `error:send:${this.#nextId}`;
      this.timeline.put({
        kind: "error",
        id: refused,
        text: "a turn is running in this session; steer it or queue a follow-up instead",
      });
      return { id: refused, outcome: Promise.resolve(new ChatRefusalError("a turn is running")) };
    }
    const running = this.timeline.state.turn === "working";
    const refusedId = `error:send:${this.#nextId}`;
    if (mode === "steer" && (!running || this.#projection.activeTurnId === undefined)) {
      this.timeline.put({
        kind: "error",
        id: refusedId,
        text: "codex has not reported an active turn to steer",
      });
      return {
        id: refusedId,
        outcome: Promise.resolve(new ChatRefusalError("codex has not reported an active turn")),
      };
    }
    // The service owns follow-up queueing and starts it as the next turn; a follow-up that reaches
    // the driver directly has no turn to run and would be a second writer, so it is refused.
    if (mode === "follow-up") {
      this.timeline.put({
        kind: "error",
        id: refusedId,
        text: "a follow-up is queued by the server, not the codex driver",
      });
      return {
        id: refusedId,
        outcome: Promise.resolve(new ChatRefusalError("a follow-up is queued by the server")),
      };
    }
    let effort = selection?.level ?? null;
    if (mode === "prompt" && selection != null) {
      const prepared = this.#prepared;
      this.#prepared = null;
      if (
        prepared === null ||
        prepared.model.id !== selection.model.id ||
        prepared.model.provider !== selection.model.provider ||
        prepared.level !== selection.level
      ) {
        const error = new ChatRefusalError("Codex has not confirmed this turn's selection");
        return { id: refusedId, outcome: Promise.resolve(error) };
      }
      effort = prepared.effort;
    }
    const itemId = `user:${this.#nextId}:${Date.now()}`;
    if (mode === "prompt" && selection != null)
      this.timeline.setState({ model: null, reasoning: null });
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
            ...(selection == null ? {} : { model: selection.model.id }),
            ...(effort === null ? {} : { effort }),
          });
    const boundary = mode === "prompt" ? Promise.withResolvers<"settled" | "aborted">() : null;
    const outcome = call.then(
      (response) => {
        if (boundary !== null) {
          const id = stringOf(recordOf(response["turn"])?.["id"]);
          if (id !== undefined) {
            const finished = this.#earlyTurnBoundaries.get(id);
            if (finished !== undefined) {
              this.#earlyTurnBoundaries.delete(id);
              boundary.resolve(finished);
            } else this.#turnBoundaries.set(id, boundary.resolve);
          }
        }
        return null;
      },
      (error: unknown) => {
        // A JSON-RPC error is the server saying no; a closed socket or timeout may still have
        // delivered the turn, so only the typed refusal is treated as definitely unsent.
        this.timeline.put({
          kind: "error",
          id: `error:send:${itemId}`,
          text: `${error instanceof ChatRefusalError ? "codex did not accept the message" : "Could not confirm whether codex accepted the message"}: ${messageOf(error)}`,
        });
        return error instanceof Error ? error : new Error(messageOf(error));
      },
    );
    return { id: itemId, outcome, ...(boundary === null ? {} : { boundary: boundary.promise }) };
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
    throw new ChatModelUnsupportedError(model, "Codex model choices are applied on the next turn");
  }

  async prepareSelection(
    selection: ChatModelSelection,
    options: { forDispatch: boolean },
  ): Promise<void> {
    if (options.forDispatch) this.#prepared = null;
    let models;
    try {
      models = await this.#loadModels();
    } catch {
      throw new ChatUnavailableError("Codex could not confirm its model list.", "turn-unconfirmed");
    }
    const model = models.find(
      (candidate) =>
        candidate.id === selection.model.id && candidate.provider === selection.model.provider,
    );
    if (model === undefined)
      throw new ChatModelUnsupportedError(selection.model, "Codex did not offer this model");
    if (selection.level !== null && !model.reasoningLevels?.includes(selection.level))
      throw new ChatReasoningUnsupportedError(selection.level, "Codex did not offer this effort");
    if (options.forDispatch) {
      let effort = selection.level;
      if (effort === null) {
        let config: Record<string, unknown> | undefined;
        try {
          config = recordOf((await this.#call("config/read", { includeLayers: false }))["config"]);
        } catch {
          // A missing default is different from the model's native default.
        }
        if (config === undefined || !("model_reasoning_effort" in config))
          throw new ChatUnavailableError(
            "Codex could not confirm the configured reasoning default.",
            "turn-unconfirmed",
          );
        const configured = config["model_reasoning_effort"];
        if (configured === null) {
          if (model.reasoningLevels?.length === 0) {
            let current: Record<string, unknown>;
            try {
              current = await this.#call("thread/resume", { threadId: this.#thread() });
            } catch {
              throw new ChatUnavailableError(
                "Codex could not confirm whether a previous effort is still active.",
                "turn-unconfirmed",
              );
            }
            if (!("reasoningEffort" in current) || current["reasoningEffort"] !== null)
              throw new ChatUnavailableError(
                "Codex cannot reset a previous effort for this model without reasoning levels.",
                "turn-unconfirmed",
              );
          } else effort = model.defaultReasoningEffort;
        } else if (typeof configured === "string" && configured.length > 0) effort = configured;
        else
          throw new ChatUnavailableError(
            "Codex could not confirm the configured reasoning default.",
            "turn-unconfirmed",
          );
        if (effort !== null && !model.reasoningLevels?.includes(effort))
          throw new ChatUnavailableError(
            "The configured Codex reasoning default is not offered by this model.",
            "turn-unconfirmed",
          );
      }
      this.#prepared = { model: selection.model, level: selection.level, effort };
    }
  }

  async refreshModels(): Promise<void> {
    try {
      await this.#loadModels();
    } catch {
      throw new ChatUnavailableError("Codex could not load its model list.", "turn-unconfirmed");
    }
  }

  async setReasoning(level: string): Promise<void> {
    throw new ChatReasoningUnsupportedError(
      level,
      "Codex reasoning choices are applied on the next turn",
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
      await this.#discoverModels();
      if (this.#closed || this.#stopping) return;
      this.#sendPromptIfNeeded();
    } catch (error) {
      if (this.#stopping || this.#closed) return;
      this.#finish(`codex chat could not start: ${messageOf(error)}`);
    }
  }

  async #discoverModels(): Promise<void> {
    try {
      await this.#loadModels(Math.min(2500, this.#request.readyTimeoutMs));
    } catch {
      // A metadata failure must not prevent an otherwise valid configured launch.
    }
  }

  #loadModels(timeoutMs = REQUEST_TIMEOUT_MS): ReturnType<typeof readCodexModels> {
    if (this.#catalogRequest !== undefined) return this.#catalogRequest;
    this.timeline.setState({ modelsStatus: "loading", reasoningStatus: "loading" });
    const deadline = Date.now() + timeoutMs;
    const request = readCodexModels(this.#provider, (params) =>
      this.#call("model/list", params, Math.max(1, deadline - Date.now())),
    )
      .then((models) => {
        if (!this.#closed) {
          const current = models.find(
            (model) =>
              model.id === this.state.model?.id && model.provider === this.state.model?.provider,
          );
          this.timeline.setState({
            models,
            modelsStatus: "ready",
            ...(current === undefined ? {} : { model: current }),
            reasoningLevels: current?.reasoningLevels ?? [],
            reasoningStatus: current === undefined ? "error" : "ready",
          });
        }
        return models;
      })
      .catch((error: unknown) => {
        if (!this.#closed)
          this.timeline.setState({ modelsStatus: "error", reasoningStatus: "error" });
        throw error;
      })
      .finally(() => {
        this.#catalogRequest = undefined;
      });
    this.#catalogRequest = request;
    return request;
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
    this.#provider = stringOf(thread["modelProvider"]) ?? this.#provider;
    this.#projection.sessionState({ id, provider: this.#provider });
  }

  /**
   * The launch's candidate first prompt, handed over only when the rebuilt conversation has no
   * user message. A restart, a `setView` into chat and a restore all re-run this after the
   * rebuild, so the transcript — not a flag on the session row — decides: a conversation that
   * already has the user's words must never receive the task prompt again (C1's P0).
   */
  #sendPromptIfNeeded(): void {
    const prompt = this.#request.prompt;
    if (prompt === null) {
      this.#request.sendInitialPrompt?.(null);
      return;
    }
    if (this.#projection.hasUserMessage()) {
      this.#request.sendInitialPrompt?.(null);
      return;
    }
    if (this.#request.sendInitialPrompt !== undefined) this.#request.sendInitialPrompt(prompt);
    else this.send(prompt, "prompt");
  }

  #onFrame(payload: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const frame = parsed;
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
        pending.reject(
          new ChatRefusalError(stringOf(error["message"]) ?? `${pending.method} failed`),
        );
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
    // The v2 approvals name `threadId`; the legacy `applyPatchApproval`/`execCommandApproval` name
    // `conversationId`, so a filter on `threadId` alone silently dropped them.
    const threadId = stringOf(params["threadId"]) ?? stringOf(params["conversationId"]);
    if (this.#threadId !== null && threadId !== undefined && threadId !== this.#threadId) return;
    // A request this client does not render (a permissions profile, an MCP elicitation, a tool
    // call), or an approval whose decisions are all object-valued, cannot become a chat item.
    if (!isApprovalMethod(method) || !this.#projection.hasPlainDecisions(method, params)) {
      this.#answerUnanswerable(requestId, method);
      return;
    }
    for (const action of this.#projection.requestApproval(requestId, method, params)) {
      this.#apply(action);
    }
  }

  /**
   * A request chat cannot render. With a live terminal leg it is that dialog's to answer — the
   * app-server sends it to every client and the first answer wins, so staying quiet is right. A
   * chat-only session has nobody else: leaving it unanswered would park the turn forever, so the
   * server is told the client cannot answer and the user gets a visible line. The refusal is an
   * error result, which is what the app-server's own clients send for a request they cannot fulfil;
   * whether Codex then fails the turn or continues is its business and C-verify's check.
   */
  #answerUnanswerable(requestId: string, method: string): void {
    if (this.#terminalLive()) return;
    this.#send({
      jsonrpc: "2.0",
      id: numericId(requestId),
      error: { code: -32601, message: `corral chat cannot answer ${method}` },
    });
    this.timeline.put({
      kind: "error",
      id: `error:request:${requestId}`,
      text: `Codex asked for ${describeRequest(method)}, which chat cannot answer; open this session's terminal view and ask again.`,
    });
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
    if (method === "turn/completed") {
      const turn = recordOf(params["turn"]);
      const id = stringOf(turn?.["id"]);
      const status = stringOf(turn?.["status"]);
      if (
        id !== undefined &&
        (status === "completed" || status === "interrupted" || status === "failed")
      ) {
        const result = status === "completed" ? "settled" : "aborted";
        const settle = this.#turnBoundaries.get(id);
        if (settle === undefined) {
          this.#earlyTurnBoundaries.set(id, result);
          if (this.#earlyTurnBoundaries.size > 128)
            this.#earlyTurnBoundaries.delete(this.#earlyTurnBoundaries.keys().next().value!);
        } else {
          this.#turnBoundaries.delete(id);
          settle(result);
        }
      }
    }
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

  /** Whether a terminal leg can answer a request right now; the session service owns the answer. */
  #terminalLive(): boolean {
    const terminal = this.#request.terminalLive;
    return typeof terminal === "function" ? terminal() : terminal === true;
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

  #call(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
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
        reject(new Error(`${method} did not answer within ${timeoutMs} ms`));
      }, timeoutMs).unref?.();
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
  return value === true ? options.find(isAllow) : options.find(isDeny);
}

function isAllow(option: string): boolean {
  return option.startsWith("accept") || option === "approved";
}

function isDeny(option: string): boolean {
  return option.startsWith("decline");
}

/** What a request the chat cannot render is, in the sentence the user reads. */
function describeRequest(method: string): string {
  switch (method) {
    case "item/permissions/requestApproval":
      return "extra permissions";
    case "mcpServer/elicitation/request":
      return "input for an MCP server";
    case "item/tool/requestUserInput":
      return "an answer from you";
    case "item/tool/call":
      return "a tool call only a terminal can run";
    default:
      return "an approval with no plain choice";
  }
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
 * The TUI is a second client of the same per-session app-server
 * (`codex --remote unix://… resume <thread>`), so opening the other view starts a client instead
 * of stopping this one.
 */
export const codexChatDriver: ChatDriverRegistration = {
  requiresPreparationSignal: true,
  capabilities: {
    steer: true,
    followUp: true,
    approvals: true,
    modelSwitch: true,
    modelRefresh: true,
    reasoningLevels: true,
    terminalView: "both-live",
  },
  args: codexChatArgs,
  create: (launch) => new CodexDriver(launch),
};

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
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
  if (Array.isArray(data)) {
    const chunks: unknown[] = data;
    return Buffer.concat(chunks.filter((each): each is Buffer => Buffer.isBuffer(each))).toString(
      "utf8",
    );
  }
  return "";
}
