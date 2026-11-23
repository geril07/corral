import type { ChatAnswer, ChatModelRef } from "@corral/protocol/chat";
import type { ChatSendMode, AgentStatus } from "@corral/protocol/rpc";
import {
  ChatModelUnsupportedError,
  ChatReasoningUnsupportedError,
  ChatRefusalError,
  ChatRequestUnknownError,
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
import {
  OpenCodeProjection,
  newOpenCodeMessageId,
  type OpenCodeAction,
} from "./opencode-projection.ts";
import type { ChatTimeline } from "./timeline.ts";

/** What OpenCode's chat frontend is started with: the launch, its server and the deadlines. */
export interface OpenCodeDriverRequest extends ChatDriverLaunch, ChatTimeouts {}

/** How many hydrate/reconnect attempts a dead server gets before the frontend is reported gone. */
const RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 250;
const REQUEST_TIMEOUT_MS = 10_000;
/** The page size asked of `GET /api/session/:id/message`; the server may return fewer. */
const HISTORY_PAGE_LIMIT = 200;
/**
 * The most pages one hydration walks. A cursor that repeats or a server that keeps inventing a
 * `cursor.next` must end the walk instead of holding the frontend on the hydrate path, so the
 * transcript is what was read so far and the timeline says it starts partway.
 */
const HISTORY_MAX_PAGES = 100;
/** The most messages one hydration keeps, for a server that returns enormous pages. */
const HISTORY_MAX_MESSAGES = 20_000;

/**
 * One OpenCode chat session: an HTTP/SSE client of the `opencode serve` Corral started for this
 * run (`opencode-server.ts`), which owns the conversation. The driver never starts a process of
 * its own — the terminal view of the same session is another client of that one server, which is
 * what makes OpenCode the first `both-live` driver.
 *
 * - The session id is Corral's (`Session.agentSessionId`, shaped `ses_…`); `POST /api/session`
 *   accepts it, so settle/continue/restart keep one id. A server that restarted without the
 *   session re-creates it under that id.
 * - Streaming is `GET /api/event`, filtered to this session by `data.sessionID`. Events carry a
 *   `durable` sequence, but the timeline's sequence is Corral's own: ordering comes from the
 *   projection, and every reconnect rebuilds the transcript from
 *   `GET /api/session/:id/message`, which is the path that works after a server restart. Only a
 *   text delta that arrives while the transcript is rebuilt is measured against the rebuilt text;
 *   a live delta is always appended whole.
 * - A permission request becomes a `select` user request (allow once, allow always, reject) sent to
 *   `POST …/permission/:requestID/reply`; an answer from the terminal's own prompt arrives as
 *   `permission.replied` and resolves the same item, so one request has one resolution.
 * - `chat.send` maps `steer` to OpenCode's `delivery: "steer"` (measured from 2.2.5's own client
 *   schema); there is no delivery for a prompt. A follow-up is Corral's own queue and is started
 *   by the service as a later prompt, not handed to OpenCode's queue, so the model it runs on is
 *   the one captured when it was queued. A prompt while a turn runs is refused instead of
 *   silently steering, because the client offers steer/follow-up by turn state (B3).
 *
 * Models and reasoning levels are declared unsupported: OpenCode 2.2.5 has per-session model
 * switching, but this slice does not map it, so `chat.capabilities` says so and the client hides
 * the controls instead of offering a call that would be refused.
 */
export class OpenCodeDriver implements ChatDriver {
  readonly timeline: ChatTimeline;
  readonly #request: OpenCodeDriverRequest;
  readonly #projection: OpenCodeProjection;
  readonly #requestTimers = new Map<string, NodeJS.Timeout>();
  #closed = false;
  #stopping = false;
  #readyTimer: NodeJS.Timeout | undefined;
  /** The live SSE body; cancelling it is how a stop ends the stream without aborting the fetch. */
  #body: ReadableStream<Uint8Array> | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #connecting = false;
  #promptSent = false;
  #hydrated = false;
  #failureReason: string | undefined;
  #lastDurableSequence = -1;
  readonly #turnBoundaries = new Map<
    string,
    { delivered: number | null; resolve: (outcome: "settled" | "aborted") => void }
  >();

  constructor(request: OpenCodeDriverRequest) {
    this.#request = request;
    this.timeline = request.timeline;
    this.#projection = new OpenCodeProjection(this.timeline, {
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

  /** Starts talking to the server. Never throws: a failure is `onExit` with its reason. */
  start(): void {
    if (this.#request.server === undefined) {
      this.#finish("the opencode chat needs the server Corral starts; none was passed");
      return;
    }
    this.#readyTimer = setTimeout(
      () => this.#finish(`opencode did not answer within ${seconds(this.#request.readyTimeoutMs)}`),
      Math.max(1, this.#request.readyTimeoutMs),
    );
    void this.#run();
  }

  /** Stops the frontend: the stream and the request deadlines end, the conversation stays. */
  async stop(): Promise<void> {
    if (this.#closed) return;
    this.#stopping = true;
    this.#clearTimers();
    for (const itemId of this.#projection.expireAll()) this.#clearRequestTimer(itemId);
    this.#finish(null);
  }

  send(text: string, mode: ChatSendMode): ChatSendReceipt {
    if (mode === "prompt" && this.timeline.state.turn === "working") {
      // The client offers steer and follow-up while a turn runs; a prompt would be a second
      // writer on the same turn, so it is refused visibly and nothing is sent — and no user item
      // is left behind for a message that never left the driver.
      const refused = `error:send:${newOpenCodeMessageId()}`;
      this.timeline.put({
        kind: "error",
        id: refused,
        text: "a turn is running in this session; steer it or queue a follow-up instead",
      });
      return { id: refused, outcome: Promise.resolve(new ChatRefusalError("a turn is running")) };
    }
    const { itemId, messageId } = this.#projection.userMessage(text);
    const boundary = mode === "prompt" ? Promise.withResolvers<"settled" | "aborted">() : null;
    if (boundary !== null)
      this.#turnBoundaries.set(messageId, { delivered: null, resolve: boundary.resolve });
    const delivery = mode === "steer" ? "steer" : "queue";
    const outcome = this.#prompt(messageId, text, delivery).then(
      () => null,
      (error: unknown) => {
        // A 4xx answer is the server rejecting the request; a lost connection or 5xx may have
        // reached the session, so it is not reported as certainly unsent.
        const refused =
          error instanceof OpenCodeHttpError && error.status < 500 && error.status !== 408;
        if (refused) this.#turnBoundaries.delete(messageId);
        this.timeline.put({
          kind: "error",
          id: `error:send:${messageId}`,
          text: `${refused ? "opencode did not accept the message" : "Could not confirm whether opencode accepted the message"}: ${messageOf(error)}`,
        });
        return refused
          ? new ChatRefusalError(messageOf(error))
          : error instanceof Error
            ? error
            : new Error(messageOf(error));
      },
    );
    return { id: itemId, outcome, ...(boundary === null ? {} : { boundary: boundary.promise }) };
  }

  /** Interrupts the running execution; a request waiting for an answer can no longer be resolved. */
  async abort(): Promise<void> {
    for (const itemId of this.#projection.expireAll()) this.#clearRequestTimer(itemId);
    try {
      await this.#json("POST", `/api/session/${encodeURIComponent(this.#session())}/interrupt`);
    } catch (error) {
      if (this.#closed) return;
      this.#projection.applyEvent({
        type: "session.execution.failed",
        data: { sessionID: this.#session(), error: { message: messageOf(error) } },
      });
    }
  }

  /** Answers a permission request; throws when the item is not waiting for one. */
  respond(itemId: string, value: ChatAnswer): void {
    const answer = this.#projection.answer(itemId, value);
    if (answer === undefined) throw new ChatRequestUnknownError(itemId);
    this.#clearRequestTimer(itemId);
    void this.#json(
      "POST",
      `/api/session/${encodeURIComponent(this.#session())}/permission/${encodeURIComponent(answer.requestId)}/reply`,
      { decision: answer.decision },
    ).catch((error: unknown) => {
      this.timeline.put({
        kind: "error",
        id: `error:permission:${answer.requestId}`,
        text: `opencode did not accept the answer: ${messageOf(error)}`,
      });
    });
    this.#report({ state: "working" });
  }

  async setModel(model: ChatModelRef): Promise<void> {
    throw new ChatModelUnsupportedError(
      model,
      "the opencode driver does not switch models in this build",
    );
  }

  async setReasoning(level: string): Promise<void> {
    throw new ChatReasoningUnsupportedError(
      level,
      "the opencode driver has no reasoning levels in this build",
    );
  }

  /** Connect, hydrate, and keep the stream alive until the frontend stops or the server dies. */
  async #run(): Promise<void> {
    let attempts = 0;
    while (!this.#stopping && !this.#closed) {
      // oxlint-disable-next-line no-await-in-loop -- one connection attempt per iteration is the point
      const outcome = await this.#connect();
      if (outcome === "connected") {
        attempts = 0;
        if (this.#stopping || this.#closed) return;
        // oxlint-disable-next-line no-await-in-loop -- the stream ended; one delay before reconnecting
        await delay(RECONNECT_DELAY_MS);
        continue;
      }
      attempts += 1;
      if (attempts >= RECONNECT_ATTEMPTS) {
        this.#finish(this.#failureReason ?? "the opencode server stopped answering");
        return;
      }
      this.#failureReason = outcome;
      // oxlint-disable-next-line no-await-in-loop -- one reconnect attempt per iteration is the point
      await delay(RECONNECT_DELAY_MS);
    }
  }

  /**
   * One connection: subscribe to the event stream, rebuild the transcript once the stream is up,
   * then apply what arrived during the rebuild. Returns `connected` when the stream ended after a
   * successful connection, or the reason it could not connect.
   */
  async #connect(): Promise<string> {
    if (this.#connecting) return "already connecting";
    this.#connecting = true;
    const buffered: unknown[] = [];
    let connected = false;
    try {
      if (!this.#hydrated) await this.#ensureSession();
      // No abort signal on the stream: aborting a fetch with an open body destroys an undici
      // response with an error nobody can observe. Cancelling the body stops the read instead, and
      // a server that has not answered yet is bounded by the ready/request deadlines.
      const response = await fetch(this.#url("/api/event"), {
        headers: {
          ...this.#authHeaders(),
          accept: "text/event-stream",
          "cache-control": "no-cache",
        },
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return `the opencode server answered ${response.status} for its events`;
      }
      const body = response.body;
      if (body === null) return "the opencode server sent no event stream";
      this.#body = body;
      if (this.#closed) {
        await body.cancel().catch(() => undefined);
        return "connected";
      }
      let parser = new ServerSentEvents();
      for await (const chunk of body) {
        const events = parser.push(new TextDecoder().decode(chunk, { stream: true }));
        for (const event of events) {
          if (!connected) {
            buffered.push(event);
            if (typeOfEvent(event) === "server.connected") {
              connected = true;
              // oxlint-disable-next-line no-await-in-loop -- hydrate once, before the buffered events
              const failure = await this.#hydrate();
              if (failure !== undefined) return failure;
              // Buffered events arrived while the transcript was being rebuilt; text they carry is
              // measured against the rebuilt text, because that snapshot may already contain it.
              for (const queued of buffered.splice(0)) this.#onEvent(queued, true);
            }
            continue;
          }
          this.#onEvent(event);
        }
        if (this.#stopping || this.#closed) return "connected";
      }
      return connected ? "connected" : "the opencode event stream ended before it connected";
    } catch (error) {
      if (this.#stopping || this.#closed) return "connected";
      return `lost the opencode server: ${messageOf(error)}`;
    } finally {
      this.#connecting = false;
      this.#body = undefined;
    }
  }

  /**
   * Each catalogued model's context window. A server whose catalog cannot be read still has a
   * transcript worth showing, so the reading loses its percentage instead of the session failing.
   */
  async #modelWindows(): Promise<Map<string, number>> {
    try {
      return modelWindowsOf(await this.#json("GET", "/api/model"));
    } catch {
      return new Map();
    }
  }

  /**
   * The whole transcript in chronological order, read newest-first page by page. Pages start at
   * `order=desc` and then follow only `cursor.next`, as the endpoint's contract requires (a cursor
   * may not be combined with `order`). Paging backwards matters when a page cap is reached: the
   * transcript then keeps the newest messages, including the current turn and every answer's model,
   * and says that earlier ones are missing instead of presenting the oldest page as the whole
   * conversation. A server that ignores `limit` answers with everything and a null cursor, which
   * ends the walk after one page.
   */
  async #history(session: string): Promise<{ messages: unknown[]; truncated: boolean }> {
    const messages: unknown[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let truncated = false;
    let complete = false;
    for (let page = 0; page < HISTORY_MAX_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: String(HISTORY_PAGE_LIMIT) });
      if (cursor === undefined) query.set("order", "desc");
      else query.set("cursor", cursor);
      // oxlint-disable-next-line no-await-in-loop -- each page starts where the previous one ended
      const body = await this.#json(
        "GET",
        `/api/session/${encodeURIComponent(session)}/message?${query.toString()}`,
      );
      let added = 0;
      for (const message of arrayField(body, "data") ?? []) {
        const id = stringField(message, "id");
        if (id !== undefined) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        if (messages.length >= HISTORY_MAX_MESSAGES) {
          truncated = true;
          break;
        }
        messages.push(message);
        added += 1;
      }
      if (truncated) break;
      const next = stringField(recordField(body, "cursor"), "next");
      if (next === undefined) {
        complete = true;
        break;
      }
      // No new message or a cursor already followed means the server is not advancing; walking it
      // again would repeat the same page until the page cap, and the cap is what reports the limit.
      if (added === 0 || cursors.has(next)) {
        truncated = true;
        break;
      }
      cursors.add(next);
      cursor = next;
    }
    if (!complete && !truncated) truncated = true;
    messages.reverse();
    return { messages, truncated };
  }

  /** Rebuilds transcript, session state and pending permissions from the server. */
  async #hydrate(): Promise<string | undefined> {
    const session = this.#session();
    try {
      const info = await this.#json("GET", `/api/session/${encodeURIComponent(session)}`);
      const data = recordField(info, "data") ?? info;
      this.#projection.sessionState({
        model: recordField(data, "model"),
        time: recordField(data, "time"),
      });
      const [history, windows] = await Promise.all([this.#history(session), this.#modelWindows()]);
      const list = history.messages;
      this.#projection.setModelWindows(windows);
      this.#projection.loadHistory(list);
      if (history.truncated) {
        this.timeline.put({
          kind: "notice",
          id: "notice:opencode-history",
          text: "Earlier messages were not loaded: opencode did not finish returning the conversation history.",
        });
      }
      const permissions = await this.#json(
        "GET",
        `/api/session/${encodeURIComponent(session)}/permission`,
      );
      for (const request of arrayField(permissions, "data") ?? []) {
        this.#onEvent({ type: "permission.asked", data: request });
      }
      if (!this.#hydrated) this.#hydrated = true;
      this.#clearReadyTimer();
      const last = lastIdleOf(list);
      if (last === "failed") this.#report({ state: "error" });
      else if (last === "interrupted") this.#report({ state: "idle" });
      else if (isBusy(this.timeline.state.turn)) this.#report({ state: "working" });
      else this.#report({ state: "done" });
      this.#sendPromptIfNeeded();
      return undefined;
    } catch (error) {
      return `the opencode session could not be read: ${messageOf(error)}`;
    }
  }

  /**
   * The launch's candidate first prompt, handed over only when the rebuilt transcript has no user
   * message. A restart, a `setView` into chat and a restore all re-run this after `#hydrate`, so
   * the transcript — not a flag on the session row — decides: a conversation that already has the
   * user's words must never receive the task prompt again.
   */
  #sendPromptIfNeeded(): void {
    if (this.#promptSent) return;
    this.#promptSent = true;
    const prompt = this.#request.prompt;
    if (prompt === null) {
      this.#request.sendInitialPrompt?.(null);
      return;
    }
    if (this.timeline.snapshot().items.some((item) => item.kind === "user-message")) {
      this.#request.sendInitialPrompt?.(null);
      return;
    }
    if (this.#request.sendInitialPrompt !== undefined) this.#request.sendInitialPrompt(prompt);
    else this.send(prompt, "prompt");
  }

  async #prompt(messageId: string, text: string, delivery: string | undefined): Promise<void> {
    await this.#json("POST", `/api/session/${encodeURIComponent(this.#session())}/prompt`, {
      id: messageId,
      text,
      ...(delivery === undefined ? {} : { delivery }),
    });
  }

  /** Creates the session under Corral's id when the server does not know it (a fresh server). */
  async #ensureSession(): Promise<void> {
    const session = this.#session();
    try {
      await this.#json("GET", `/api/session/${encodeURIComponent(session)}`);
    } catch (error) {
      if (!(error instanceof OpenCodeHttpError) || error.status !== 404) throw error;
      await this.#json("POST", "/api/session", {
        id: session,
        location: { directory: this.#request.cwd },
      });
    }
  }

  #onEvent(event: unknown, replay = false): void {
    if (this.#closed) return;
    const type = typeOfEvent(event);
    if (type === undefined) return;
    if (type === "session.created" || type === "session.deleted") return;
    const data = recordOf(recordField(event, "data"));
    if (data === undefined) return;
    if (stringField(data, "sessionID") !== this.#session()) return;
    const durable = recordOf(recordField(event, "durable"));
    const sequence = durable?.["seq"];
    if (
      durable?.["aggregateID"] === this.#session() &&
      typeof sequence === "number" &&
      Number.isSafeInteger(sequence)
    ) {
      if (sequence <= this.#lastDurableSequence) return;
      this.#lastDurableSequence = sequence;
    }
    if (!replay) this.#observeTurnBoundary(type, data, durable);
    for (const action of this.#projection.applyEvent(
      { type, data, ...eventShape(event) },
      { replay },
    ))
      this.#apply(action);
  }

  #observeTurnBoundary(
    type: string,
    data: Record<string, unknown>,
    durable: Record<string, unknown> | undefined,
  ): void {
    const seq = durable?.["seq"];
    if (
      typeof seq !== "number" ||
      !Number.isSafeInteger(seq) ||
      durable?.["aggregateID"] !== this.#session()
    )
      return;
    if (type === "session.inbox.delivered") {
      const id = stringField(data, "inboxID");
      const pending = id === undefined ? undefined : this.#turnBoundaries.get(id);
      if (pending !== undefined) pending.delivered = seq;
      return;
    }
    if (
      type !== "session.execution.succeeded" &&
      type !== "session.execution.interrupted" &&
      type !== "session.execution.failed"
    )
      return;
    // Shutdown leaves OpenCode's execution claim in place for recovery.
    if (type === "session.execution.interrupted" && data["reason"] === "shutdown") return;
    for (const [id, pending] of this.#turnBoundaries) {
      if (pending.delivered === null || seq <= pending.delivered) continue;
      this.#turnBoundaries.delete(id);
      pending.resolve(type === "session.execution.succeeded" ? "settled" : "aborted");
    }
  }

  #apply(action: OpenCodeAction): void {
    switch (action.type) {
      case "status":
        this.#report(action);
        break;
      case "request-opened": {
        this.#requestTimers.set(
          action.itemId,
          setTimeout(
            () => {
              // Corral stops waiting; OpenCode's own deadline (if any) remains the backstop.
              const item = this.timeline.item(action.itemId);
              if (item?.kind === "user-request" && item.status === "pending")
                this.timeline.put({ ...item, status: "expired" });
              this.#clearRequestTimer(action.itemId);
            },
            Math.max(1, this.#projection.dialogTimeoutMs),
          ).unref(),
        );
        this.#report({ state: "blocked", kind: "question" });
        break;
      }
      case "request-closed":
        this.#clearRequestTimer(action.itemId);
        break;
    }
  }

  #report(action: {
    state: AgentStatus["state"];
    message?: string | undefined;
    kind?: "question";
  }): void {
    const status: AgentStatus = {
      state: action.state,
      updatedAt: Date.now(),
      ...(action.kind === undefined ? {} : { kind: action.kind }),
      ...(action.message === undefined ? {} : { message: action.message }),
    };
    this.#request.onStatus(status);
  }

  #finish(reason: string | null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTimers();
    this.#clearReadyTimer();
    void this.#body?.cancel().catch(() => undefined);
    this.#request.onExit(reason);
  }

  #clearTimers(): void {
    for (const timer of this.#requestTimers.values()) clearTimeout(timer);
    this.#requestTimers.clear();
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  #clearRequestTimer(itemId: string): void {
    const timer = this.#requestTimers.get(itemId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#requestTimers.delete(itemId);
  }

  #clearReadyTimer(): void {
    if (this.#readyTimer === undefined) return;
    clearTimeout(this.#readyTimer);
    this.#readyTimer = undefined;
  }

  #session(): string {
    const session = this.#request.agentSessionId;
    if (session === null) throw new Error("the opencode session has no agent session id");
    return session;
  }

  #url(path: string): string {
    return `${this.#request.server!.url}${path}`;
  }

  #authHeaders(): Record<string, string> {
    const credentials = Buffer.from(`opencode:${this.#request.server!.password}`).toString(
      "base64",
    );
    return { authorization: `Basic ${credentials}` };
  }

  /** One JSON request to the server; a non-2xx answer is its typed error with the status. */
  async #json(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(this.#url(path), {
      method,
      headers: {
        ...this.#authHeaders(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        accept: "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new OpenCodeHttpError(response.status, detailOf(text, response.status));
    }
    if (response.status === 204) return undefined;
    const text = await response.text();
    if (text === "") return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new OpenCodeHttpError(response.status, "the opencode server answered with non-JSON");
    }
  }
}

/** A non-2xx answer from the server; `status` lets a caller tell a missing session from a dead one. */
class OpenCodeHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "OpenCodeHttpError";
    this.status = status;
  }
}

function detailOf(text: string, status: number): string {
  try {
    const parsed: unknown = JSON.parse(text);
    const message = recordField(parsed, "message") ?? recordField(parsed, "error");
    if (typeof message === "string" && message !== "") return message;
  } catch {
    // Not JSON: the text itself is the best description there is.
  }
  return text === "" ? `the opencode server answered ${status}` : text;
}

/** A minimal SSE parser: LF frames, `data:` lines, `:` comments (the heartbeat) ignored. */
class ServerSentEvents {
  #buffer = "";

  push(chunk: string): unknown[] {
    this.#buffer += chunk;
    const events: unknown[] = [];
    let boundary = frameBoundary(this.#buffer);
    while (boundary !== undefined) {
      const frame = this.#buffer.slice(0, boundary.index);
      this.#buffer = this.#buffer.slice(boundary.index + boundary.length);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data !== "") {
        try {
          events.push(JSON.parse(data));
        } catch {
          // A frame that is not JSON is not ours to interpret; the next one may be.
        }
      }
      boundary = frameBoundary(this.#buffer);
    }
    return events;
  }
}

function frameBoundary(text: string): { index: number; length: number } | undefined {
  const lf = text.indexOf("\n\n");
  const crlf = text.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return undefined;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function typeOfEvent(event: unknown): string | undefined {
  return stringField(event, "type");
}

function eventShape(event: unknown): { id?: string; created?: number } {
  const id = stringField(event, "id");
  const created = recordOf(event)?.["created"];
  return {
    ...(typeof id === "string" ? { id } : {}),
    ...(typeof created === "number" ? { created } : {}),
  };
}

function lastIdleOf(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const record = recordOf(messages[index]);
    if (record?.["type"] !== "idle") continue;
    const outcome = record["outcome"];
    return typeof outcome === "string" ? outcome : undefined;
  }
  return undefined;
}

function isBusy(turn: string): boolean {
  return turn === "working";
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(value: unknown, key: string): unknown {
  return recordOf(value)?.[key];
}

/**
 * The `limit.context` of every model in the catalog (`GET /api/model`), keyed the way a session's
 * message names its model. A catalog entry carries both `id` and `modelID`; a message's ref uses
 * `id`, which is the key that has to match.
 */
function modelWindowsOf(body: unknown): Map<string, number> {
  const windows = new Map<string, number>();
  for (const entry of arrayField(body, "data") ?? []) {
    const provider = stringField(entry, "providerID");
    const id = stringField(entry, "id") ?? stringField(entry, "modelID");
    const context = recordField(recordField(entry, "limit"), "context");
    if (provider === undefined || id === undefined || typeof context !== "number") continue;
    if (!Number.isInteger(context) || context <= 0) continue;
    windows.set(`${provider}/${id}`, context);
  }
  return windows;
}

function stringField(value: unknown, key: string): string | undefined {
  const field = recordField(value, key);
  return typeof field === "string" ? field : undefined;
}

function arrayField(value: unknown, key: string): unknown[] | undefined {
  const field = recordField(value, key);
  return Array.isArray(field) ? field : undefined;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)).unref());
}

/** The chat argv a launch of this driver would use: the driver is an HTTP client, so there is none. */
function openCodeChatArgs(_facts: ChatLaunchFacts): string[] {
  return [];
}

/**
 * The TUI attaches to the same server with `--server <url> --session <id>`, so opening the
 * other view starts a client instead of stopping this one.
 */
export const openCodeChatDriver: ChatDriverRegistration = {
  requiresPreparationSignal: true,
  capabilities: {
    steer: true,
    followUp: true,
    approvals: true,
    modelSwitch: false,
    reasoningLevels: false,
    terminalView: "both-live",
  },
  args: openCodeChatArgs,
  create: (launch) => new OpenCodeDriver(launch),
};
