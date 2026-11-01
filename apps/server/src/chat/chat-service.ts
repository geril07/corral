import type { ChatStreamMessage } from "@corral/protocol/chat";
import { rmSync } from "node:fs";
import type { AgentKind, AgentStatus, ChatSendMode } from "@corral/protocol/rpc";
import type { ChatAnswer, ChatModelRef } from "@corral/protocol/chat";
import { CHAT_DRIVERS } from "./chat-drivers.ts";
import { ChatLaunchError, ChatUnavailableError, type ChatSubject } from "./chat-errors.ts";
import { PiDriver, type PiDriverTimeouts } from "./pi-driver.ts";
import { floorPath, raiseFloor, reserveFloor } from "./sequence-floor.ts";
import { releasePreviousWriter, writerPath } from "./writer-claim.ts";

/**
 * The agents this build can show as chat (B0's contract); the list itself is in `chat-drivers.ts`,
 * which the config file also reads to fall a `chat` view back to the terminal.
 */
export { CHAT_DRIVERS };

/**
 * The server's own deadline for a dialog pi left open. An extension may set a shorter `timeout`
 * on its request, which pi resolves locally; this is the backstop for a request without one, so a
 * blocked session is not blocked forever. The contract's `expiresAt` carries it to the client.
 */
const DIALOG_TIMEOUT_MS = 10 * 60 * 1000;
/** Start-up commands (history, state, models) must answer within this or the frontend fails. */
const READY_TIMEOUT_MS = 15_000;
/** After stdin closes: pi exits in order; this is how long it gets before its group is killed. */
const EXIT_GRACE_MS = 2000;

export interface ChatLaunchRequest {
  sessionId: string;
  /** The agent executable to run; the argument list already carries `--mode rpc`. */
  command: string;
  args: string[];
  cwd: string;
  /** The launch environment, exactly as a terminal launch of this session would get it. */
  env: Record<string, string>;
  /** Sent with the `prompt` command when pi reports no conversation yet; null for none. */
  prompt: string | null;
  onStatus(status: AgentStatus): void;
  /** The frontend is gone; `reason` is null for a stop the server asked for. */
  onExit(reason: string | null): void;
}

export interface ChatServiceOptions {
  /** Where the per-session writer records live; inside the server's data directory. */
  dataDir: string;
  /** Test seam; the defaults are what production runs. */
  timeouts?: Partial<PiDriverTimeouts> & { writerWaitMs?: number };
}

/**
 * The chat frontends of one server run, addressed by session id. There is at most one per session
 * by construction: a launch claims its session id *before* its first await, so two concurrent
 * launches cannot both pass the "is one running?" check, and the session service serialises its
 * own mutations through one queue.
 */
export class ChatService {
  readonly #drivers = new Map<string, PiDriver>();
  /**
   * Launches between their claim and their spawn, by session id. The claim is taken synchronously,
   * before the previous writer is awaited, so a second `launch` of the same id is refused instead
   * of racing the first to `spawn`.
   */
  readonly #launching = new Map<string, Promise<void>>();

  /**
   * How the last frontend of a session ended during this run: a reason string when it crashed or
   * was failed, null when the server stopped it. It is what `chat.watch` reports, so a client that
   * connects after the stream ended learns how it ended instead of watching nothing.
   */
  readonly #lastExit = new Map<string, string | null>();
  readonly #chatDir: string;
  readonly #timeouts: PiDriverTimeouts;
  readonly #writerWaitMs: number;

  constructor(options: ChatServiceOptions) {
    this.#chatDir = `${options.dataDir}/chat`;
    this.#timeouts = {
      dialogTimeoutMs: options.timeouts?.dialogTimeoutMs ?? DIALOG_TIMEOUT_MS,
      readyTimeoutMs: options.timeouts?.readyTimeoutMs ?? READY_TIMEOUT_MS,
      exitGraceMs: options.timeouts?.exitGraceMs ?? EXIT_GRACE_MS,
    };
    this.#writerWaitMs = options.timeouts?.writerWaitMs ?? 3000;
  }

  /** The agent kinds with a chat driver in this build. */
  capabilities(): AgentKind[] {
    return [...CHAT_DRIVERS];
  }

  /** Whether this build can run the agent as chat at all. */
  hasDriver(kind: ChatSubject["kind"]): boolean {
    return kind !== "shell" && CHAT_DRIVERS.includes(kind);
  }

  /**
   * Spawns a session's chat frontend. A writer recorded by a previous server is stopped first:
   * two writers corrupt one pi session, so the launch fails rather than race one.
   */
  async launch(request: ChatLaunchRequest): Promise<void> {
    const { sessionId } = request;
    if (this.#drivers.has(sessionId) || this.#launching.has(sessionId))
      throw new ChatLaunchError(`session ${sessionId} already has a chat frontend`);
    // Claimed synchronously: the await below is what two concurrent launches used to race over.
    const launching = this.#spawnFrontend(request);
    this.#launching.set(sessionId, launching);
    try {
      await launching;
    } finally {
      if (this.#launching.get(sessionId) === launching) this.#launching.delete(sessionId);
    }
  }

  /** Stops a previous server's writer, reserves this frontend's sequence block and spawns it. */
  async #spawnFrontend(request: ChatLaunchRequest): Promise<void> {
    const { sessionId } = request;
    const claimPath = writerPath(this.#chatDir, sessionId);
    await releasePreviousWriter(claimPath, { waitMs: this.#writerWaitMs });
    // Reserved before the spawn and persisted, so a cursor from any earlier frontend — including
    // one a crashed server left behind — is below this timeline's start and gets a snapshot.
    const floor = floorPath(this.#chatDir, sessionId);
    const startAt = reserveFloor(floor);
    const driver: PiDriver = new PiDriver({
      ...request,
      ...this.#timeouts,
      startAt,
      claimPath,
      onExit: (reason) => {
        if (this.#drivers.get(sessionId) === driver) this.#drivers.delete(sessionId);
        raiseFloor(floor, driver.timeline.sequence + 1);
        this.#lastExit.set(sessionId, reason);
        request.onExit(reason);
      },
    });
    this.#drivers.set(sessionId, driver);
    this.#lastExit.delete(sessionId);
    driver.start();
  }

  /**
   * Closes stdin, waits for pi to exit, then kills its group; resolves once it is gone. A launch
   * still in flight is awaited first, so a stop cannot return while a child is being spawned.
   */
  async stop(sessionId: string): Promise<void> {
    await this.#launching.get(sessionId)?.catch(() => undefined);
    const driver = this.#drivers.get(sessionId);
    if (driver === undefined) return;
    await driver.stop();
  }

  /**
   * Forgets a removed session's persisted sequence floor and exit state. The writer record belongs
   * to the live child and is gone once it stopped.
   */
  forget(sessionId: string): void {
    this.#lastExit.delete(sessionId);
    rmSync(floorPath(this.#chatDir, sessionId), { force: true });
  }

  /** Stops every frontend; the server is shutting down and cleans up after itself. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.#launching.values()].map((launch) => launch.catch(() => undefined)));
    await Promise.all([...this.#drivers.values()].map((driver) => driver.stop()));
  }

  /**
   * `chat.watch`: the snapshot and events of a session's frontend. A cursor below the timeline's
   * start — from the frontend this one replaced — is a hole, so the client gets a snapshot; that
   * holds for every watcher and across a server restart because the start is persisted.
   */
  watch(
    subject: ChatSubject,
    after: number | undefined,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ChatStreamMessage> {
    return this.#frontend(subject).timeline.watch(after, signal);
  }

  /**
   * Ends a working turn before its frontend is taken away, as a view handoff does: pi is sent the
   * abort, any dialog waiting for an answer is cancelled, and the turn is given the same grace a
   * stop gives to report that it ended. A turn pi closes is written to its own session, so the
   * conversation keeps it; a child killed mid-turn may write nothing. A frontend that is idle, or
   * none at all, is left alone. The stop that follows is what removes the frontend, whatever this
   * wait saw — it never replaces it.
   */
  async abortWorking(sessionId: string): Promise<void> {
    const driver = this.#drivers.get(sessionId);
    if (driver === undefined || driver.closed || driver.state.turn !== "working") return;
    await driver.abort().catch(() => undefined);
    const deadline = Date.now() + this.#timeouts.exitGraceMs;
    while (!driver.closed && driver.state.turn === "working" && Date.now() < deadline) {
      // oxlint-disable-next-line no-await-in-loop -- waiting for pi to say the turn ended
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  send(subject: ChatSubject, text: string, mode: ChatSendMode): string {
    return this.#frontend(subject).send(text, mode);
  }

  async abort(subject: ChatSubject): Promise<void> {
    await this.#frontend(subject).abort();
  }

  respond(subject: ChatSubject, requestId: string, value: ChatAnswer): void {
    this.#frontend(subject).respond(requestId, value);
  }

  async setModel(subject: ChatSubject, model: ChatModelRef): Promise<void> {
    await this.#frontend(subject).setModel(model);
  }

  async setReasoning(subject: ChatSubject, level: string): Promise<void> {
    await this.#frontend(subject).setReasoning(level);
  }

  /**
   * The live frontend of this subject, or the refusal `CHAT_UNAVAILABLE` carries: a terminal
   * session and an agent without a driver can never be chat (`no-driver`); a frontend that ended
   * in this run says how (`exited`); one that the server stopped, or that never ran since the
   * server started, can be started (`not-started`).
   */
  #frontend(subject: ChatSubject): PiDriver {
    if (subject.kind === "shell" || !CHAT_DRIVERS.includes(subject.kind)) {
      const agent = subject.kind === "shell" ? "a shell" : `the ${subject.kind} agent`;
      throw new ChatUnavailableError(`${agent} has no chat driver`, "no-driver");
    }
    if (subject.view !== "chat")
      throw new ChatUnavailableError("this session runs in a terminal, not in chat", "no-driver");
    const driver = this.#drivers.get(subject.sessionId);
    if (driver !== undefined && !driver.closed) return driver;
    const lastExit = this.#lastExit.get(subject.sessionId);
    if (lastExit !== undefined) {
      if (lastExit !== null) throw new ChatUnavailableError(lastExit, "exited");
      throw new ChatUnavailableError(
        "the chat frontend is stopped; start the session to open it again",
        "not-started",
      );
    }
    throw new ChatUnavailableError(
      subject.state === "running"
        ? "the chat frontend is not running"
        : "the chat frontend is not started; start the session to open it",
      subject.state === "running" ? "exited" : "not-started",
    );
  }
}
