import type { ChatDriverCapabilities, ChatStreamMessage } from "@corral/protocol/chat";
import { rmSync } from "node:fs";
import { AgentKind, type ChatSendMode } from "@corral/protocol/rpc";
import type { ChatAnswer, ChatModelRef } from "@corral/protocol/chat";
import { CHAT_DRIVER_REGISTRY } from "./chat-drivers.ts";
import type {
  ChatDriver,
  ChatDriverRegistration,
  ChatDriverRegistry,
  ChatLaunchRequest,
  ChatTimeouts,
  ChatWriterClaim,
} from "./chat-driver.ts";
import {
  ChatLaunchError,
  ChatUnavailableError,
  messageOf,
  type ChatSubject,
} from "./chat-errors.ts";
import { floorPath, raiseFloor, reserveFloor } from "./sequence-floor.ts";
import { ChatTimeline } from "./timeline.ts";
import { recordWriter, releasePreviousWriter, releaseWriter, writerPath } from "./writer-claim.ts";

/**
 * The server's own deadline for a dialog a driver left open. An extension may set a shorter
 * `timeout` on its request, which the agent resolves locally; this is the backstop for a request
 * without one, so a blocked session is not blocked forever. The contract's `expiresAt` carries it
 * to the client.
 */
const DIALOG_TIMEOUT_MS = 10 * 60 * 1000;
/** Start-up commands (history, state, models) must answer within this or the frontend fails. */
const READY_TIMEOUT_MS = 15_000;
/** After a stop request the agent exits in order; this is how long it gets before its group dies. */
const EXIT_GRACE_MS = 2000;

export interface ChatServiceOptions {
  /** Where the per-session writer records live; inside the server's data directory. */
  dataDir: string;
  /** Test seam; the defaults are what production runs. */
  timeouts?: Partial<ChatTimeouts> & { writerWaitMs?: number };
  /** Test seam; production runs the build's registry (`CHAT_DRIVER_REGISTRY`). */
  drivers?: ChatDriverRegistry;
}

/**
 * The chat frontends of one server run, addressed by session id. There is at most one per session
 * by construction: a launch claims its session id *before* its first await, so two concurrent
 * launches cannot both pass the "is one running?" check, and the session service serialises its
 * own mutations through one queue.
 */
export class ChatService {
  readonly #drivers = new Map<string, ChatDriver>();
  /**
   * The drivers this service can start, by agent kind. Production passes the build's registry;
   * the seam is what lets a test register a driver without a line of service code behind it.
   */
  readonly #registry: ChatDriverRegistry;
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
  readonly #timeouts: ChatTimeouts;
  readonly #writerWaitMs: number;

  constructor(options: ChatServiceOptions) {
    this.#chatDir = `${options.dataDir}/chat`;
    this.#registry = options.drivers ?? CHAT_DRIVER_REGISTRY;
    this.#timeouts = {
      dialogTimeoutMs: options.timeouts?.dialogTimeoutMs ?? DIALOG_TIMEOUT_MS,
      readyTimeoutMs: options.timeouts?.readyTimeoutMs ?? READY_TIMEOUT_MS,
      exitGraceMs: options.timeouts?.exitGraceMs ?? EXIT_GRACE_MS,
    };
    this.#writerWaitMs = options.timeouts?.writerWaitMs ?? 3000;
  }

  /** What `chat.capabilities` answers: one declared capability record per driver in this build. */
  capabilities(): ChatDriverCapabilities[] {
    const records: ChatDriverCapabilities[] = [];
    for (const kind of AgentKind.options) {
      const registration = this.#registry[kind];
      if (registration !== undefined) records.push({ kind, ...registration.capabilities });
    }
    return records;
  }

  /** Whether this build can run the agent as chat at all. */
  hasDriver(kind: ChatSubject["kind"]): boolean {
    return kind !== "shell" && this.#registry[kind] !== undefined;
  }

  /**
   * Spawns a session's chat frontend through its agent's registered driver. A writer recorded by a
   * previous server is stopped first: two writers corrupt one agent session, so the launch fails
   * rather than race one.
   */
  async launch(request: ChatLaunchRequest): Promise<void> {
    const { sessionId } = request;
    // An agent this build has no driver for is refused here, before anything is claimed or read.
    const registration = this.#registry[request.kind];
    if (registration === undefined)
      throw new ChatLaunchError(`the ${request.kind} agent has no chat driver in this build`);
    if (this.#drivers.has(sessionId) || this.#launching.has(sessionId))
      throw new ChatLaunchError(`session ${sessionId} already has a chat frontend`);
    // Claimed synchronously: the await below is what two concurrent launches used to race over.
    const launching = this.#spawnFrontend(request, registration);
    this.#launching.set(sessionId, launching);
    try {
      await launching;
    } finally {
      if (this.#launching.get(sessionId) === launching) this.#launching.delete(sessionId);
    }
  }

  /**
   * Stops a previous server's writer, reserves this frontend's sequence block, builds the agent's
   * chat argv through the driver and spawns it.
   *
   * What is the driver's and what is the service's is deliberately asymmetric: the argv is the
   * driver's; the timeline (its start is the reserved floor), the writer record (its path, and the
   * pid identity inside it), the exit bookkeeping and the refusal vocabulary are the service's. A
   * driver receives the timeline and a `record`/`release` pair and cannot pick either.
   */
  async #spawnFrontend(
    request: ChatLaunchRequest,
    registration: ChatDriverRegistration,
  ): Promise<void> {
    const { sessionId } = request;
    const claimPath = writerPath(this.#chatDir, sessionId);
    await releasePreviousWriter(claimPath, { waitMs: this.#writerWaitMs });
    // Reserved before the spawn and persisted, so a cursor from any earlier frontend — including
    // one a crashed server left behind — is below this timeline's start and gets a snapshot. The
    // timeline is built here rather than by the driver: a driver that chose its own start would
    // silently replay a stale cursor instead of snapshotting (a second frontend of one session).
    const floor = floorPath(this.#chatDir, sessionId);
    const timeline = new ChatTimeline(reserveFloor(floor));
    const writer: ChatWriterClaim = {
      record: (pid) => recordWriter(claimPath, pid),
      release: () => releaseWriter(claimPath),
    };
    /** Every way out of a frontend, including a driver that threw where it promised `onExit`. */
    const exit = (reason: string | null) => {
      if (this.#drivers.get(sessionId) === driver) this.#drivers.delete(sessionId);
      raiseFloor(floor, timeline.sequence + 1);
      this.#lastExit.set(sessionId, reason);
      request.onExit(reason);
    };
    const driver: ChatDriver = registration.create({
      sessionId,
      timeline,
      command: request.command,
      args: registration.args({
        model: request.model,
        provider: request.provider,
        agentSessionId: request.agentSessionId,
        how: request.how,
      }),
      cwd: request.cwd,
      env: request.env,
      prompt: request.prompt,
      writer,
      ...this.#timeouts,
      onStatus: (status) => request.onStatus(status),
      onExit: exit,
    });
    // A driver that streams into its own timeline would put a stale cursor back on the floor.
    if (driver.timeline !== timeline) {
      raiseFloor(floor, timeline.sequence + 1);
      throw new ChatLaunchError(
        `the ${request.kind} chat driver did not use the timeline it was given`,
      );
    }
    this.#drivers.set(sessionId, driver);
    this.#lastExit.delete(sessionId);
    try {
      driver.start();
    } catch (error) {
      // A driver that throws instead of reporting through `onExit` is treated as one that exited:
      // the id is freed, the floor is raised and the reason is visible, exactly as a crash is.
      exit(messageOf(error));
    }
  }

  /**
   * Stops the session's driver through the interface (stdin closed, exit awaited, group killed for
   * a child); resolves once the frontend is gone. A launch still in flight is awaited first, so a
   * stop cannot return while a child is being spawned.
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
   * Ends a working turn before its frontend is taken away, as a view handoff does: the driver is
   * sent the abort (which cancels any dialog waiting for an answer) and the turn is given the same
   * grace a stop gives to report that it ended.
   *
   * Both waits are bounded, the abort itself included: an agent that is alive but never answers would
   * otherwise park the handoff inside the session queue and keep `stop`, `restart`, `remove` and
   * the server's shutdown queued behind it forever. The race and the poll share one deadline, so
   * this call costs at most one grace; the stop that follows then allows its own grace for the exit
   * before it kills the group, so a child that ignores both the abort and stdin EOF costs about two
   * graces in all — bounded, which is what keeps the queue moving, not one grace exactly. A turn the
   * agent closes is written to its own session, so the conversation keeps it; a child killed
   * mid-turn may write nothing. A frontend that is idle, or none at all, is left alone. The stop that follows is
   * what removes the frontend, whatever these waits saw — they never replace it.
   */
  async abortWorking(sessionId: string): Promise<void> {
    const driver = this.#drivers.get(sessionId);
    if (driver === undefined || driver.closed || driver.state.turn !== "working") return;
    const deadline = Date.now() + this.#timeouts.exitGraceMs;
    await Promise.race([driver.abort().catch(() => undefined), delay(deadline - Date.now())]);
    while (!driver.closed && driver.state.turn === "working" && Date.now() < deadline) {
      // oxlint-disable-next-line no-await-in-loop -- waiting for the agent to say the turn ended
      await delay(25);
    }
  }

  /**
   * Before an agent starts in a terminal: a chat frontend of this session may still hold the
   * agent's session file — a server that died, or a child that outlived its kill, leaves the
   * record — and a terminal launch writes the same file. The record is honoured here too, so the one-writer rule
   * covers chat → terminal and not only chat → chat. A shell never had a chat frontend; nothing to
   * check.
   */
  async releaseWriterBeforeTerminal(sessionId: string): Promise<void> {
    await releasePreviousWriter(writerPath(this.#chatDir, sessionId), {
      waitMs: this.#writerWaitMs,
    });
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
  #frontend(subject: ChatSubject): ChatDriver {
    if (subject.kind === "shell" || this.#registry[subject.kind] === undefined) {
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

/** A timer that cannot keep the process alive on its own; the work it bounds can. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)).unref());
}
