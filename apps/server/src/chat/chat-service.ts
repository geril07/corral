import type {
  ChatDriverCapabilities,
  ChatItem,
  ChatModelRef,
  ChatModelSelection,
  ChatQueuedMessage,
  ChatQueueStatus,
  ChatSelectionIssue,
  ChatSessionState,
  ChatStreamMessage,
  ChatTurnState,
} from "@corral/protocol/chat";
import { rmSync } from "node:fs";
import { AgentKind, type ChatSendMode } from "@corral/protocol/rpc";
import type { ChatAnswer } from "@corral/protocol/chat";
import { modelKey, modelScopeKey } from "@corral/protocol/models";
import { CHAT_DRIVER_REGISTRY } from "./chat-drivers.ts";
import {
  MemoryChatChoices,
  sameModelRef,
  selectionKey,
  type ChatChoiceScope,
  type ChatChoiceStore,
} from "./chat-choices.ts";
import type {
  ChatDriver,
  ChatDriverRegistration,
  ChatDriverRegistry,
  ChatLaunchRequest,
  ChatSendReceipt,
  ChatTimeouts,
  ChatWriterClaim,
} from "./chat-driver.ts";
import {
  ChatLaunchError,
  ChatModelLevelError,
  ChatModelUnsupportedError,
  ChatReasoningUnsupportedError,
  ChatRefusalError,
  ChatUnavailableError,
  messageOf,
  type ChatSubject,
} from "./chat-errors.ts";
import { floorPath, raiseFloor, reserveFloor } from "./sequence-floor.ts";
import { ChatTimeline } from "./timeline.ts";
import { recordWriter, releasePreviousWriter, releaseWriter, writerPath } from "./writer-claim.ts";
import { newId } from "../storage/ids.ts";
import { SerialQueue } from "../tasks/serial-queue.ts";

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
  /**
   * The server-owned session selection, thinking memory and queue. Production passes the SQLite
   * store so they outlive a restart; the in-memory default is what a bare test harness gets.
   */
  choices?: ChatChoiceStore;
  /**
   * A chat frontend put an item that may have changed its workspace: a tool call. The changes read
   * model recomputes that session's task from it; the server wires this to `ChangesService`.
   */
  onWorkspaceChange?: (sessionId: string) => void;
}

/**
 * What the service holds for one live frontend beside the driver: the session's next-turn choice,
 * its queue, and the turn facts the boundary logic needs. It is removed with the frontend.
 */
interface TurnControl {
  driver: ChatDriver;
  sessionId: string;
  /** The agent and profile a thinking level is remembered under; fixed for the session. */
  scope: ChatChoiceScope;
  selection: ChatModelSelection | null;
  /** The part of `selection` the live driver has not confirmed; never persisted. */
  selectionIssue: ChatSelectionIssue | null;
  queue: ChatQueuedMessage[];
  /** The driver has reported a model or a list; nothing can be applied before that. */
  ready: boolean;
  /** The turn state the boundary observer last saw. */
  lastTurn: ChatTurnState;
  /** The levels and models last seen, so a fresh report re-tries a skipped choice. */
  offerSignature: string;
  /** A boundary pass is queued or running; another request coalesces into one more pass. */
  driveQueued: boolean;
  /** A boundary arrived while a pass was running; one more pass follows it. */
  driveAgain: boolean;
  /**
   * The queued entry handed to the driver whose delivery the agent has not answered yet, or null
   * when no attempt is in flight. The next entry is not handed over before this is: a turn's
   * settled boundary can arrive while the attempt that opened it is still unconfirmed, and starting
   * the next one then could run it ahead of a message that may never have reached the agent.
   */
  attempt: DispatchAttempt | null;
  /** The last token handed to an attempt; a late answer is matched against the current one. */
  attemptToken: number;
  initialPending: boolean;
  resumed: boolean;
  initialModel: string | null;
  initialProvider: string | null;
  expectedModel: ChatModelRef | undefined;
  terminalLive: boolean | (() => boolean);
  sharedTerminal: boolean;
  orderedTurnBoundaries: boolean;
  recoveryQueued: boolean;
  recoveryAgain: boolean;
  /** The selection this launch already tried and failed to apply, so it is not retried in a loop. */
  failedSelection: string | null;
  unsubscribe: () => void;
}

/**
 * One queued delivery the service is waiting on. The receipt answers long after the pass that sent
 * it released the session queue, and a stop, an abort or a newer attempt may have ended this one in
 * between; the token is what keeps a late answer from being read as the current attempt's.
 */
interface DispatchAttempt {
  /** The queue row this attempt is for. */
  id: string;
  token: number;
  delivery: "pending" | "accepted" | "unknown";
  sawWorking: boolean;
  settled: boolean;
  nativeBoundary: "none" | "pending" | "settled" | "aborted";
  failed: boolean;
}

/**
 * The chat frontends of one server run, addressed by session id. There is at most one per session
 * by construction: a launch claims its session id *before* its first await, so two concurrent
 * launches cannot both pass the "is one running?" check, and the session service serialises its
 * own mutations through one queue.
 */
export class ChatService {
  readonly #drivers = new Map<string, ChatDriver>();
  readonly #turns = new Map<string, TurnControl>();
  readonly #mutations = new WeakMap<ChatDriver, SerialQueue>();
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
  readonly #choices: ChatChoiceStore;
  readonly #memoryEpochs = new Map<string, number>();
  readonly #pendingInitialMemory = new Map<
    string,
    { scope: ChatChoiceScope; selection: ChatModelSelection; epoch: number }
  >();
  readonly #onWorkspaceChange: ((sessionId: string) => void) | undefined;

  constructor(options: ChatServiceOptions) {
    this.#chatDir = `${options.dataDir}/chat`;
    this.#registry = options.drivers ?? CHAT_DRIVER_REGISTRY;
    this.#choices = options.choices ?? new MemoryChatChoices();
    this.#timeouts = {
      dialogTimeoutMs: options.timeouts?.dialogTimeoutMs ?? DIALOG_TIMEOUT_MS,
      readyTimeoutMs: options.timeouts?.readyTimeoutMs ?? READY_TIMEOUT_MS,
      exitGraceMs: options.timeouts?.exitGraceMs ?? EXIT_GRACE_MS,
    };
    this.#writerWaitMs = options.timeouts?.writerWaitMs ?? 3000;
    this.#onWorkspaceChange = options.onWorkspaceChange;
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

  /** A new session's explicit choice is stored before its frontend can dispatch the first prompt. */
  initializeSelection(
    sessionId: string,
    scope: ChatChoiceScope,
    selection: ChatModelSelection,
    remember: boolean,
  ): void {
    this.#choices.setSelection(sessionId, selection);
    if (remember && selection.level !== null) {
      if (scope.kind === "pi") {
        this.#pendingInitialMemory.set(sessionId, {
          scope,
          selection,
          epoch: this.#memoryEpoch(scope, selection.model),
        });
      } else this.rememberLevel(scope, selection.model, selection.level);
    }
  }

  cancelInitialSelection(sessionId: string): void {
    this.#pendingInitialMemory.delete(sessionId);
  }

  rememberedLevel(scope: ChatChoiceScope, model: ChatModelRef): string | null {
    return this.#choices.rememberedLevel(scope, model);
  }

  rememberLevel(scope: ChatChoiceScope, model: ChatModelRef, level: string): void {
    this.#choices.rememberLevel(scope, model, level);
    const key = `${modelScopeKey(scope)}\n${modelKey(model)}`;
    this.#memoryEpochs.set(key, (this.#memoryEpochs.get(key) ?? 0) + 1);
  }

  #memoryEpoch(scope: ChatChoiceScope, model: ChatModelRef): number {
    return this.#memoryEpochs.get(`${modelScopeKey(scope)}\n${modelKey(model)}`) ?? 0;
  }

  #confirmInitialMemory(control: TurnControl, selection: ChatModelSelection): void {
    const pending = this.#pendingInitialMemory.get(control.sessionId);
    if (pending === undefined || selectionKey(pending.selection) !== selectionKey(selection))
      return;
    this.#pendingInitialMemory.delete(control.sessionId);
    if (
      selection.level !== null &&
      control.selection !== null &&
      selectionKey(control.selection) === selectionKey(selection) &&
      this.#memoryEpoch(pending.scope, selection.model) === pending.epoch
    )
      this.rememberLevel(pending.scope, selection.model, selection.level);
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
    // The changes read model listens here rather than on a repository watcher: a tool call is the
    // one signal the server has that an agent touched its workspace (a terminal agent has none).
    timeline.observeItems((item) => {
      if (item.kind === "tool-call") this.#onWorkspaceChange?.(sessionId);
    });
    const writer: ChatWriterClaim = {
      record: (pid) => recordWriter(claimPath, pid),
      release: () => releaseWriter(claimPath),
    };
    /** Every way out of a frontend, including a driver that threw where it promised `onExit`. */
    const exit = (reason: string | null) => {
      if (this.#drivers.get(sessionId) === driver) this.#drivers.delete(sessionId);
      this.cancelInitialSelection(sessionId);
      const control = this.#turns.get(sessionId);
      if (control !== undefined && control.driver === driver) {
        control.unsubscribe();
        this.#turns.delete(sessionId);
        // Nothing was sent after the frontend went away; the queue must not look runnable on the
        // next launch. Persisting is enough here: no watcher is left to show an item to.
        this.#haltQueue(control, { surface: false });
      }
      raiseFloor(floor, timeline.sequence + 1);
      this.#lastExit.set(sessionId, reason);
      request.onExit(reason);
    };
    const driver: ChatDriver = registration.create({
      sessionId,
      timeline,
      command: request.command,
      args: [
        ...(request.instanceArgs ?? []),
        ...registration.args({
          model: request.model,
          provider: request.provider,
          agentSessionId: request.agentSessionId,
          how: request.how,
        }),
      ],
      cwd: request.cwd,
      env: request.env,
      how: request.how,
      prompt: request.prompt,
      sendInitialPrompt: (text) => this.#initialPrompt(sessionId, text),
      onRecoveryOpportunity: () => {
        if (this.#drivers.get(sessionId) === driver) this.#scheduleRecovery(sessionId);
      },
      model: request.model,
      provider: request.provider,
      agentSessionId: request.agentSessionId,
      ...(request.server === undefined ? {} : { server: request.server }),
      ...(request.socket === undefined ? {} : { socket: request.socket }),
      ...(request.terminalLive === undefined ? {} : { terminalLive: request.terminalLive }),
      ...(request.onAgentSessionId === undefined
        ? {}
        : {
            onAgentSessionId: (agentSessionId: string) => request.onAgentSessionId!(agentSessionId),
          }),
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
      // The persisted choice and queue are part of the snapshot before the driver's first event,
      // so a client that connects during the rebuild already sees them.
      this.#startTurns(driver, request, timeline);
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

  /**
   * A prompt starts on the session's selection, a steer uses the running turn unchanged, and a
   * follow-up is the server's queue. A prompt whose selection cannot be applied is refused: the
   * message must not leave on some other model or level while the client believes it chose this
   * one.
   */
  send(subject: ChatSubject, text: string, mode: ChatSendMode): Promise<string> {
    if (mode === "follow-up") return this.#enqueue(subject, text);
    if (mode === "steer") return Promise.resolve(this.#frontend(subject).send(text, mode).id);
    return this.#mutate(subject, async (driver) => {
      const control = this.#control(subject.sessionId, driver);
      if (mode === "prompt" && (this.#blocked(control) || driver.state.turn === "working"))
        throw turnUnconfirmed();
      if (mode === "prompt" && driver.state.turn !== "working") {
        const issue = await this.#applySelection(control, control.selection, {
          strict: false,
          forDispatch: true,
        });
        // A skipped level is not a reason to deliver the words on the level the agent happens to
        // have: the user asked for this one, and the state says it cannot be applied.
        if (issue !== null) throw new ChatReasoningUnsupportedError(issue.level, mentionOf(issue));
        if (this.#blocked(control) || driver.timeline.state.turn === "working")
          throw turnUnconfirmed();
      }
      if (mode !== "prompt") return driver.send(text, mode).id;
      const entry = this.#createEntry(control, text);
      return this.#dispatch(control, entry);
    });
  }

  async abort(subject: ChatSubject): Promise<void> {
    const driver = this.#frontend(subject);
    const control = this.#control(subject.sessionId, driver);
    this.#haltQueue(control, { surface: true, preserveAttempt: true });
    await driver.abort();
  }

  respond(subject: ChatSubject, requestId: string, value: ChatAnswer): void {
    this.#frontend(subject).respond(requestId, value);
  }

  /**
   * Chooses the model of the session's later turns. While a turn runs, nothing is sent to the
   * driver: the running turn keeps its model and this one is applied when the turn ends. With no
   * explicit level, the level last chosen for this agent, profile and model is used when the
   * driver currently offers it; the memory survives even when it does not.
   */
  async setModel(subject: ChatSubject, model: ChatModelRef, level?: string): Promise<void> {
    await this.#mutate(subject, async (driver) => {
      const registration = subject.kind === "shell" ? undefined : this.#registry[subject.kind];
      if (registration === undefined || !registration.capabilities.modelSwitch)
        throw new ChatModelUnsupportedError(
          model,
          `the ${subject.kind} agent does not switch models in this build`,
        );
      if (
        driver.prepareSelection === undefined &&
        driver.state.models.length > 0 &&
        !driver.state.models.some((candidate) => sameModelRef(candidate, model))
      )
        throw new ChatModelUnsupportedError(model, `the ${subject.kind} agent does not offer it`);
      const control = this.#control(subject.sessionId, driver);
      const remembered =
        level === undefined ? this.#choices.rememberedLevel(control.scope, model) : null;
      const selection: ChatModelSelection = { model, level: level ?? remembered };
      if (level !== undefined && driver.prepareSelection !== undefined)
        await driver.prepareSelection(selection, { forDispatch: false });
      // An explicit level is the user's memory even if applying it fails now; a remembered one is
      // already there. The stored selection keeps the request either way; `selectionIssue` is what
      // says the live driver has not confirmed it.
      this.cancelInitialSelection(subject.sessionId);
      if (level !== undefined) this.rememberLevel(control.scope, model, level);
      control.selection = selection;
      control.failedSelection = null;
      this.#choices.setSelection(subject.sessionId, selection);
      this.#publish(control);
      if (driver.state.turn === "working" || this.#blocked(control)) {
        // Nothing reaches the driver under a running turn; a level already known to be gone is
        // still refused now, rather than discovered only when the queue or a prompt is blocked.
        if (level !== undefined && driver.prepareSelection === undefined)
          this.#refuseLevelOffline(control, model, level);
        return;
      }
      const issue = await this.#applySelection(control, selection, { strict: level !== undefined });
      if (level !== undefined && issue !== null)
        throw new ChatReasoningUnsupportedError(level, mentionOf(issue));
    });
  }

  /** Chooses the reasoning level of the selected model for the session's later turns. */
  async setReasoning(subject: ChatSubject, level: string): Promise<void> {
    await this.#mutate(subject, async (driver) => {
      const registration = subject.kind === "shell" ? undefined : this.#registry[subject.kind];
      if (registration === undefined || !registration.capabilities.reasoningLevels)
        throw new ChatReasoningUnsupportedError(
          level,
          `the ${subject.kind} agent has no reasoning levels in this build`,
        );
      const control = this.#control(subject.sessionId, driver);
      const model = control.selection?.model ?? driver.state.model;
      if (model === null)
        throw new ChatReasoningUnsupportedError(
          level,
          "the session has no model to set a level on",
        );
      const selection: ChatModelSelection = {
        model: { provider: model.provider, id: model.id },
        level,
      };
      if (driver.prepareSelection !== undefined)
        await driver.prepareSelection(selection, { forDispatch: false });
      this.cancelInitialSelection(subject.sessionId);
      this.rememberLevel(control.scope, model, level);
      control.selection = selection;
      control.failedSelection = null;
      this.#choices.setSelection(subject.sessionId, selection);
      this.#publish(control);
      if (driver.state.turn === "working" || this.#blocked(control)) {
        if (driver.prepareSelection === undefined)
          this.#refuseLevelOffline(control, selection.model, level);
        return;
      }
      const issue = await this.#applySelection(control, selection, { strict: true });
      if (issue !== null) throw new ChatReasoningUnsupportedError(level, mentionOf(issue));
    });
  }

  #mutate<T>(subject: ChatSubject, action: (driver: ChatDriver) => Promise<T>): Promise<T> {
    const driver = this.#frontend(subject);
    let queue = this.#mutations.get(driver);
    if (!queue) {
      queue = new SerialQueue();
      this.#mutations.set(driver, queue);
    }
    return queue.run(async () => {
      if (this.#frontend(subject) !== driver)
        throw new ChatUnavailableError("the chat frontend was replaced", "exited");
      return action(driver);
    });
  }

  /**
   * The choice and queue a frontend starts with. The queue is published before the first event so
   * a client that attaches during the rebuild sees the same server truth as one that was there.
   */
  #startTurns(driver: ChatDriver, request: ChatLaunchRequest, timeline: ChatTimeline): TurnControl {
    const queue = this.#choices.queue(request.sessionId).map((entry) => {
      const status =
        entry.status === "uncertain-idle"
          ? "uncertain"
          : entry.status === "accepted-idle"
            ? "boundary-unknown"
            : entry.status;
      if (status !== entry.status)
        this.#choices.setQueueStatus(request.sessionId, entry.id, status);
      return Object.assign({}, entry, { status });
    });
    const control: TurnControl = {
      driver,
      sessionId: request.sessionId,
      scope: { kind: request.kind, profileId: request.profileId ?? null },
      selection: this.#choices.selection(request.sessionId),
      selectionIssue: null,
      queue,
      ready: false,
      lastTurn: driver.state.turn,
      offerSignature: offerSignatureOf(driver.state),
      driveQueued: false,
      driveAgain: false,
      attempt: null,
      attemptToken: 0,
      initialPending:
        request.prompt !== null || this.#registry[request.kind]?.requiresPreparationSignal === true,
      resumed: request.how === "resume",
      initialModel: request.model,
      initialProvider: request.provider,
      expectedModel: request.expectedModel,
      terminalLive: request.terminalLive ?? false,
      sharedTerminal:
        this.#registry[request.kind]?.capabilities.terminalView === "both-live" &&
        this.#registry[request.kind]?.capabilities.modelSwitch === true,
      orderedTurnBoundaries: this.#registry[request.kind]?.orderedTurnBoundaries === true,
      recoveryQueued: false,
      recoveryAgain: false,
      failedSelection: null,
      unsubscribe: () => undefined,
    };
    this.#turns.set(request.sessionId, control);
    // A fresh session has nothing to publish; writing the empty defaults would be an event that
    // says nothing and would move the timeline off its reserved start before the driver starts.
    if (control.selection !== null || control.queue.length > 0) {
      this.#publish(control);
      this.#surfaceStopped(control);
    }
    control.unsubscribe = timeline.observeState((state) => this.#observed(control, state));
    return control;
  }

  #control(sessionId: string, driver: ChatDriver): TurnControl {
    const control = this.#turns.get(sessionId);
    if (control === undefined || control.driver !== driver)
      throw new ChatUnavailableError("the chat frontend was replaced", "exited");
    return control;
  }

  /**
   * Writes the server-owned part of the state. The driver's own `model`/`reasoning` stay its
   * confirmed facts; this is only the later-turn choice and the queue. A closed timeline takes no
   * more events: the frontend is gone and the next launch publishes from the store.
   */
  #publish(control: TurnControl): void {
    if (control.driver.timeline.closed) return;
    control.driver.timeline.setState({
      selection: control.selection,
      selectionIssue: control.selectionIssue,
      queue: control.queue.filter((entry) => entry.status !== "completed"),
      followUp: control.queue
        .filter((entry) => entry.status === "queued")
        .map((entry) => entry.text),
    });
  }

  /**
   * The turn boundary. A settled turn is the only one that runs the queue; a stopped, aborted or
   * failed turn leaves its queued messages unsent, because the turn they were waiting for is not
   * the one that would have run them. The driver's first model report is the other moment: it is
   * when the stored selection can be applied and when messages a previous run left unsent are
   * shown.
   */
  #observed(control: TurnControl, state: ChatSessionState): void {
    const previous = control.lastTurn;
    control.lastTurn = state.turn;
    const attempt = control.attempt;
    if (attempt !== null) {
      if (state.turn === "error") attempt.failed = true;
      if (state.turn === "working") attempt.sawWorking = true;
      if (attempt.sawWorking && previous === "working" && state.turn === "settled") {
        attempt.settled = true;
      }
    }
    if (!control.ready && (state.models.length > 0 || state.model !== null)) {
      control.ready = true;
      if (state.turn !== "working") this.#scheduleDrive(control);
    }
    // A fresh catalog or level report is the only evidence that a skipped level came back; it
    // also invalidates the "already failed" mark, which otherwise keeps a selection dormant.
    const offer = offerSignatureOf(state);
    if (offer !== control.offerSignature) {
      control.offerSignature = offer;
      control.failedSelection = null;
      if (control.ready && state.turn !== "working") this.#scheduleDrive(control);
    }
    if (previous !== "working" || state.turn === "working") return;
    if (state.turn === "settled") this.#scheduleDrive(control);
    else if (attempt?.nativeBoundary !== "pending") this.#haltQueue(control, { surface: true });
  }

  #scheduleDrive(control: TurnControl): void {
    if (control.driveQueued) {
      control.driveAgain = true;
      return;
    }
    control.driveQueued = true;
    void this.#serialize(control, () => this.#drive(control))
      .catch((error: unknown) => {
        if (control.driver.closed) return;
        this.#surfaceError(
          control,
          "chat:selection",
          `The next turn could not start: ${messageOf(error)}`,
        );
      })
      .finally(() => {
        control.driveQueued = false;
        if (!control.driveAgain) return;
        control.driveAgain = false;
        this.#scheduleDrive(control);
      });
  }

  /** The same serial queue as a client mutation, so a boundary cannot race a send or a choice. */
  #serialize<T>(control: TurnControl, job: () => Promise<T>): Promise<T> {
    let queue = this.#mutations.get(control.driver);
    if (!queue) {
      queue = new SerialQueue();
      this.#mutations.set(control.driver, queue);
    }
    return queue.run(async () => {
      if (this.#drivers.get(control.sessionId) !== control.driver || control.driver.closed)
        throw new ChatUnavailableError("the chat frontend was replaced", "exited");
      return job();
    });
  }

  /** A receipt and a turn boundary are independent: neither alone releases a later turn. */
  async #drive(control: TurnControl): Promise<void> {
    const driver = control.driver;
    const attempt = control.attempt;
    if (
      attempt !== null &&
      attempt.delivery === "accepted" &&
      ((control.orderedTurnBoundaries && attempt.settled) ||
        attempt.nativeBoundary === "settled" ||
        attempt.nativeBoundary === "aborted")
    ) {
      this.#settleAttempt(control, attempt);
      if (attempt.id === initialId(control.sessionId))
        this.#setQueueStatus(control, attempt.id, "completed");
      else this.#removeQueued(control, attempt.id);
      if (attempt.nativeBoundary === "aborted" || attempt.failed)
        this.#haltQueue(control, { surface: true });
    }
    if (driver.closed || driver.state.turn === "working" || this.#blocked(control)) return;
    const head = control.queue.find((entry) => entry.status === "queued");
    if (head !== undefined) {
      await this.#runQueued(control, head);
      return;
    }
    const selection = control.selection;
    if (selection === null) return;
    const key = selectionKey(selection);
    if (control.failedSelection === key) return;
    try {
      const issue = await this.#applySelection(control, selection, { strict: false });
      if (issue === null) {
        control.failedSelection = null;
        return;
      }
      // Nothing is sent at a boundary with no message; the state carries the reason and a send
      // refuses until the level is chosen again or a fresh report offers it.
      control.failedSelection = key;
    } catch (error) {
      control.failedSelection = key;
      if (driver.closed) return;
      this.#surfaceError(
        control,
        "chat:selection",
        `The selected model or thinking level could not be applied: ${messageOf(error)}`,
      );
    }
  }

  async #runQueued(control: TurnControl, entry: ChatQueuedMessage): Promise<void> {
    const driver = control.driver;
    let issue: ChatSelectionIssue | null;
    try {
      issue = await this.#applySelection(control, entry.selection, {
        strict: false,
        forDispatch: true,
      });
    } catch (error) {
      this.#setQueueStatus(control, entry.id, "undelivered");
      this.#haltQueue(control, {
        surface: true,
        reason: `the queued turn could not start: ${messageOf(error)}`,
      });
      this.#surfaceQueued(
        control,
        entry.id,
        `the queued turn could not start: ${messageOf(error)}`,
      );
      return;
    }
    if (issue !== null) {
      // The captured level is part of what the user queued; substituting another one would run
      // words they did not choose on it.
      this.#setQueueStatus(control, entry.id, "undelivered");
      this.#haltQueue(control, { surface: true, reason: mentionOf(issue) });
      this.#surfaceQueued(control, entry.id, mentionOf(issue));
      return;
    }
    if (this.#blocked(control) || driver.state.turn === "working") return;
    if (driver.closed || this.#drivers.get(control.sessionId) !== driver) {
      // The send was never attempted, so this is not an uncertain delivery.
      this.#setQueueStatus(control, entry.id, "undelivered");
      return;
    }
    this.#dispatch(control, entry);
  }

  #dispatch(control: TurnControl, entry: ChatQueuedMessage): string {
    const driver = control.driver;
    this.#setQueueStatus(control, entry.id, "sending");
    const attempt: DispatchAttempt = {
      id: entry.id,
      token: ++control.attemptToken,
      delivery: "pending",
      sawWorking: false,
      settled: false,
      nativeBoundary: "none",
      failed: false,
    };
    control.attempt = attempt;
    // The guard must exist before `send`: some drivers report working synchronously.
    let receipt: ChatSendReceipt;
    try {
      receipt = driver.send(entry.text, "prompt", entry.selection);
    } catch (error) {
      this.#settleAttempt(control, attempt);
      this.#setQueueStatus(control, entry.id, "undelivered");
      this.#surfaceQueued(control, entry.id, `the message could not be sent: ${messageOf(error)}`);
      // Certainly unsent, so the entries behind it are still runnable.
      if (!driver.closed) this.#scheduleDrive(control);
      throw error;
    }
    if (receipt.boundary !== undefined) {
      attempt.nativeBoundary = "pending";
      void receipt.boundary.then((boundary) => {
        if (this.#turns.get(control.sessionId) !== control || control.attempt !== attempt) return;
        // A correlated native boundary names this prompt and proves delivery even if its transport
        // receipt was lost. Never infer the same from an uncorrelated session state.
        if (attempt.delivery === "unknown") {
          attempt.delivery = "accepted";
          this.#setQueueStatus(control, attempt.id, "accepted");
          control.driver.timeline.put({
            kind: "notice",
            id: `chat:queue:${attempt.id}`,
            text: "The agent later confirmed this message and its turn boundary.",
          });
        }
        attempt.nativeBoundary = boundary;
        this.#scheduleDrive(control);
      });
    }
    // Waiting here would prevent a steer or a later selection from reaching the service.
    void receipt.outcome.then((failure) => this.#queuedOutcome(control, attempt, failure));
    return receipt.id;
  }

  /**
   * Ends the attempt if it is still the current one, and says whether it was. A receipt carries its
   * own attempt, not only a row id: an answer for an attempt a stop, an abort or a newer dispatch
   * already ended must leave the newer attempt's guard alone.
   */
  #settleAttempt(control: TurnControl, attempt: DispatchAttempt): boolean {
    if (control.attempt?.token !== attempt.token) return false;
    control.attempt = null;
    return true;
  }

  /**
   * Applies one queued attempt's delivery outcome after the pass that sent it released the queue.
   * An attempt a stop, abort or exit already ended keeps its status: a late answer cannot turn an
   * uncertain attempt into a sent one, nor surface a second failure beside the one already shown.
   */
  #queuedOutcome(control: TurnControl, attempt: DispatchAttempt, failure: Error | null): void {
    if (this.#turns.get(control.sessionId) !== control) return;
    if (control.attempt?.token !== attempt.token) return;
    const entry = control.queue.find((candidate) => candidate.id === attempt.id);
    if (entry === undefined || entry.status !== "sending") return;
    if (failure === null) {
      // The driver reported the agent took the message. That is at-most-once from Corral's side: a
      // crash after this point cannot be told apart from a turn the agent ran, so it is never
      // resent.
      attempt.delivery = "accepted";
      const status =
        control.orderedTurnBoundaries || attempt.nativeBoundary !== "none"
          ? "accepted"
          : "boundary-unverified";
      this.#setQueueStatus(control, attempt.id, status);
      if (status === "boundary-unverified") this.#surfaceQueued(control, attempt.id);
      if (!control.driver.closed) this.#scheduleDrive(control);
      return;
    }
    if (attempt.nativeBoundary === "settled" || attempt.nativeBoundary === "aborted") {
      attempt.delivery = "accepted";
      this.#setQueueStatus(control, attempt.id, "accepted");
      if (!control.driver.closed) this.#scheduleDrive(control);
      return;
    }
    // A typed refusal is the agent saying no; anything else may already have reached it. Neither
    // is resent, and the text stays in the queue.
    const status: ChatQueueStatus =
      failure instanceof ChatRefusalError ? "undelivered" : "uncertain";
    if (status === "undelivered") this.#settleAttempt(control, attempt);
    else attempt.delivery = "unknown";
    this.#setQueueStatus(control, attempt.id, status);
    this.#surfaceQueued(control, attempt.id, `the message was not accepted: ${messageOf(failure)}`);
    if (status === "undelivered" && !control.driver.closed) this.#scheduleDrive(control);
  }

  #blocked(control: TurnControl): boolean {
    const terminalLive =
      typeof control.terminalLive === "function" ? control.terminalLive() : control.terminalLive;
    return (
      control.initialPending ||
      control.attempt !== null ||
      (control.sharedTerminal && terminalLive) ||
      control.queue.some(
        (entry) =>
          entry.status === "uncertain" ||
          entry.status === "boundary-unknown" ||
          entry.status === "boundary-unverified",
      )
    );
  }

  #createEntry(control: TurnControl, text: string, id = `queued:${newId()}`): ChatQueuedMessage {
    const entry: ChatQueuedMessage = {
      id,
      text,
      selection:
        control.selection ??
        (control.scope.kind === "codex" ? null : appliedSelection(control.driver)),
      status: "queued",
    };
    this.#choices.enqueue(control.sessionId, entry);
    control.queue = [...control.queue, entry];
    this.#publish(control);
    return entry;
  }

  #initialPrompt(sessionId: string, text: string | null): void {
    const control = this.#turns.get(sessionId);
    if (control === undefined || !control.initialPending) return;
    void this.#serialize(control, async () => {
      await this.#recoverIdle(control);
      if (
        !control.resumed &&
        control.expectedModel !== undefined &&
        control.selection === null &&
        !sameModelRef(control.driver.state.model, control.expectedModel)
      ) {
        control.initialPending = false;
        control.selection = { model: control.expectedModel, level: null };
        this.#choices.setSelection(sessionId, control.selection);
        this.#publish(control);
        if (text !== null) {
          const entry = this.#createEntry(control, text, initialId(sessionId));
          this.#setQueueStatus(control, entry.id, "undelivered");
          this.#surfaceQueued(control, entry.id, "the selected model was not confirmed");
        } else {
          this.#surfaceError(
            control,
            "chat:initial-model",
            "The selected model was not confirmed. Choose a model and thinking level before sending.",
          );
        }
        return;
      }
      this.#restoreInitialLevel(control);
      control.initialPending = false;
      if (text === null) {
        this.#scheduleDrive(control);
        return;
      }
      // Only a prompt this chat frontend already recorded is withheld. A resume alone is not
      // evidence of delivery: a handoff from the terminal has no entry here, and the driver has
      // reported the agent's own history empty, so the prompt never got through.
      if (control.queue.some((entry) => entry.id === initialId(sessionId))) {
        this.#surfaceError(
          control,
          "chat:initial-prompt",
          `The initial prompt was not sent again because its earlier delivery cannot be ruled out: ${text}`,
        );
        this.#scheduleDrive(control);
        return;
      }
      if (this.#blocked(control) || control.driver.state.turn === "working") {
        this.#surfaceError(
          control,
          "chat:initial-prompt",
          `The initial prompt was not sent because an earlier turn is unconfirmed: ${text}`,
        );
        return;
      }
      const issue = await this.#applySelection(control, control.selection, {
        strict: false,
        forDispatch: true,
      });
      if (issue !== null) throw new ChatReasoningUnsupportedError(issue.level, mentionOf(issue));
      if (this.#blocked(control) || control.driver.timeline.state.turn === "working")
        throw turnUnconfirmed();
      this.#dispatch(control, this.#createEntry(control, text, initialId(sessionId)));
    }).catch((error: unknown) => {
      this.#surfaceError(
        control,
        "chat:initial-prompt",
        `The initial prompt was not sent: ${text} (${messageOf(error)})`,
      );
    });
  }

  #restoreInitialLevel(control: TurnControl): void {
    if (
      control.resumed ||
      (control.scope.kind !== "pi" && control.scope.kind !== "codex") ||
      control.selection !== null
    )
      return;
    const state = control.driver.state;
    const candidates =
      control.initialModel === null
        ? state.model === null
          ? []
          : [state.model]
        : state.models.filter(
            (model) =>
              (control.initialProvider === null || model.provider === control.initialProvider) &&
              (model.id === control.initialModel ||
                `${model.provider}/${model.id}` === control.initialModel),
          );
    if (candidates.length !== 1) return;
    const model = candidates[0]!;
    const level = this.#choices.rememberedLevel(control.scope, model);
    if (level === null || this.#levelOffer(control.driver, model, level) !== "offered") return;
    const selection = { model: { provider: model.provider, id: model.id }, level };
    control.selection = selection;
    this.#choices.setSelection(control.sessionId, selection);
    this.#publish(control);
  }

  #scheduleRecovery(sessionId: string): void {
    const control = this.#turns.get(sessionId);
    if (control === undefined || !control.resumed || control.driver.recoverIdle === undefined)
      return;
    if (control.recoveryQueued) {
      control.recoveryAgain = true;
      return;
    }
    control.recoveryQueued = true;
    void this.#serialize(control, async () => {
      await this.#recoverIdle(control);
      if (!control.initialPending) this.#scheduleDrive(control);
    })
      .catch(() => undefined)
      .finally(() => {
        control.recoveryQueued = false;
        if (!control.recoveryAgain) return;
        control.recoveryAgain = false;
        this.#scheduleRecovery(sessionId);
      });
  }

  async #recoverIdle(control: TurnControl): Promise<void> {
    if (
      !control.resumed ||
      control.attempt !== null ||
      control.driver.recoverIdle === undefined ||
      !control.queue.some(
        (entry) =>
          entry.status === "uncertain" ||
          entry.status === "boundary-unknown" ||
          entry.status === "boundary-unverified",
      ) ||
      !(await control.driver.recoverIdle()) ||
      control.driver.closed
    )
      return;
    for (const entry of control.queue) {
      if (entry.status === "uncertain") this.#setQueueStatus(control, entry.id, "uncertain-idle");
      else if (entry.status === "boundary-unknown" || entry.status === "boundary-unverified")
        this.#setQueueStatus(control, entry.id, "accepted-idle");
      else continue;
      this.#surfaceQueued(control, entry.id);
    }
  }

  /**
   * Applies a model and level to the live driver and reports the level it could not confirm.
   * `strict` is the caller's own explicit choice: its level is attempted and a refusal is reported
   * even though the model may already have changed. A deferred or remembered level is only applied
   * when a fresh report offers it; a skipped level stays in the selection and in the memory, is
   * never substituted, and is returned as the issue the caller must decide about.
   */
  async #applySelection(
    control: TurnControl,
    selection: ChatModelSelection | null,
    options: { strict: boolean; forDispatch?: boolean },
  ): Promise<ChatSelectionIssue | null> {
    if (selection === null) {
      if (control.selection === null) this.#setSelectionIssue(control, null);
      return null;
    }
    const driver = control.driver;
    if (driver.closed) throw new ChatUnavailableError("the chat frontend was stopped", "exited");
    // A queued entry may capture another model and level than the composer's selection; its
    // failure must not be published as the composer's issue.
    const records =
      control.selection !== null && selectionKey(control.selection) === selectionKey(selection);
    const record = (issue: ChatSelectionIssue | null) => {
      if (records) this.#setSelectionIssue(control, issue);
    };
    if (driver.prepareSelection !== undefined) {
      try {
        await driver.prepareSelection(selection, { forDispatch: options.forDispatch === true });
        record(null);
        return null;
      } catch (error) {
        if (error instanceof ChatReasoningUnsupportedError && selection.level !== null) {
          const issue: ChatSelectionIssue = { level: selection.level, reason: "unavailable" };
          record(issue);
          if (!options.strict) return issue;
        }
        if (error instanceof ChatUnavailableError && selection.level !== null)
          record({ level: selection.level, reason: "unconfirmed" });
        throw error;
      }
    }
    const switched = !sameModelRef(driver.state.model, selection.model);
    const { level } = selection;
    if (level !== null) driver.timeline.setState({ modelSelectionPending: true });
    try {
      if (switched) await driver.setModel(selection.model);
      if (driver.closed) throw new ChatUnavailableError("the chat frontend was stopped", "exited");
      if (!sameModelRef(driver.state.model, selection.model))
        throw new ChatModelUnsupportedError(
          selection.model,
          "the selected model was not confirmed",
        );
      if (level === null) {
        // An absent choice is not a request to reset the agent's current setting.
        record(null);
        return null;
      }
      const offer = this.#levelOffer(driver, selection.model, level);
      if (!options.strict && offer !== "offered") {
        const issue: ChatSelectionIssue = {
          level,
          reason: offer === "removed" ? "unavailable" : "unconfirmed",
        };
        record(issue);
        return issue;
      }
      try {
        if (driver.closed)
          throw new ChatUnavailableError("the chat frontend was stopped", "exited");
        if (driver.state.reasoning !== level) await driver.setReasoning(level);
      } catch (error) {
        // The model switch was accepted; only its level was refused. A failed switch stays a
        // failure of the model, not a partial result.
        record({ level, reason: "unavailable" });
        if (switched) throw new ChatModelLevelError(selection.model, level);
        throw error;
      }
      if (driver.closed) throw new ChatUnavailableError("the chat frontend was stopped", "exited");
      // A driver that answers without moving the level did not apply it; claiming otherwise would
      // be the silent deliver-on-another-level case this state exists to prevent.
      if (driver.state.reasoning !== level) {
        const issue: ChatSelectionIssue = { level, reason: "unavailable" };
        record(issue);
        throw new ChatReasoningUnsupportedError(level, mentionOf(issue));
      }
      this.#confirmInitialMemory(control, selection);
      record(null);
      return null;
    } finally {
      if (level !== null && !driver.closed)
        driver.timeline.setState({ modelSelectionPending: false });
    }
  }

  /**
   * Whether the live report offers the level. Freshness is checked before the level's presence: a
   * list that is still loading or whose refresh failed is not a fresh report, so a cached level
   * still in it is no evidence the model takes it — and a failure is not evidence of removal
   * either. Only a fresh list decides `offered`/`removed`. A driver with no separate level query
   * leaves the status unset; its model report is the one it has.
   *
   * Another model's list is the catalog's report, not the live query the running model has, and a
   * switch re-reads it before the level is applied, so it decides only whether to try.
   */
  #levelOffer(driver: ChatDriver, model: ChatModelRef, level: string): LevelOffer {
    const status = driver.state.reasoningStatus;
    if (status === "loading" || status === "error") return "unconfirmed";
    if (sameModelRef(driver.state.model, model)) {
      return driver.state.reasoningLevels.includes(level) ? "offered" : "removed";
    }
    const levels = driver.state.models.find((candidate) =>
      sameModelRef(candidate, model),
    )?.reasoningLevels;
    if (levels === undefined) return "unconfirmed";
    return levels.includes(level) ? "offered" : "removed";
  }

  /** Records the unconfirmed part of the selection; publishing only when it changed. */
  #setSelectionIssue(control: TurnControl, issue: ChatSelectionIssue | null): void {
    const current = control.selectionIssue;
    if (current?.level === issue?.level && current?.reason === issue?.reason) return;
    control.selectionIssue = issue;
    this.#publish(control);
  }

  /**
   * Refuses an explicit level while a turn runs: nothing can be attempted under it, and a level the
   * current report does not offer would otherwise wait silently for a boundary that cannot apply
   * it.
   */
  #refuseLevelOffline(control: TurnControl, model: ChatModelRef, level: string): void {
    const offer = this.#levelOffer(control.driver, model, level);
    if (offer === "offered") return;
    const issue: ChatSelectionIssue = {
      level,
      reason: offer === "removed" ? "unavailable" : "unconfirmed",
    };
    this.#setSelectionIssue(control, issue);
    throw new ChatReasoningUnsupportedError(level, mentionOf(issue));
  }

  #enqueue(subject: ChatSubject, text: string): Promise<string> {
    return this.#mutate(subject, async (driver) => {
      const control = this.#control(subject.sessionId, driver);
      // The queue stores the choice the message is meant to run on. A level the live driver has
      // not confirmed is not that choice, so the message is refused instead of being queued with a
      // value that would have to be substituted later.
      if (control.selectionIssue !== null)
        throw new ChatReasoningUnsupportedError(
          control.selectionIssue.level,
          mentionOf(control.selectionIssue),
        );
      const message: ChatQueuedMessage = {
        id: `queued:${newId()}`,
        text,
        selection: control.selection ?? appliedSelection(driver),
        status: "queued",
      };
      this.#choices.enqueue(subject.sessionId, message);
      control.queue = [...control.queue, message];
      this.#publish(control);
      // An idle frontend has no turn to wait for: this entry is the next turn and starts now.
      // A working one waits for the settled boundary.
      if (driver.state.turn !== "working") this.#scheduleDrive(control);
      return message.id;
    });
  }

  #setQueueStatus(control: TurnControl, id: string, status: ChatQueueStatus): void {
    this.#choices.setQueueStatus(control.sessionId, id, status);
    control.queue = control.queue.map((entry) => (entry.id === id ? { ...entry, status } : entry));
    this.#publish(control);
  }

  #removeQueued(control: TurnControl, id: string): void {
    this.#choices.removeQueued(control.sessionId, id);
    control.queue = control.queue.filter((entry) => entry.id !== id);
    this.#publish(control);
  }

  /**
   * Ends every queued turn this frontend will not run: a stop, an abort, a failed turn, or a queue
   * entry whose model or level could not be applied. Nothing is deleted, so the text and its
   * captured selection survive for the user; nothing is retried, so a duplicate send cannot happen.
   * A `sending` entry is one whose attempt already left the server, so it becomes `uncertain`.
   */
  #haltQueue(
    control: TurnControl,
    options: { surface: boolean; reason?: string; preserveAttempt?: boolean },
  ): void {
    // Whatever attempt was in flight is ended by this halt: its answer, arriving later, belongs to
    // an attempt the queue no longer waits on and must not release a newer one.
    const preserved = options.preserveAttempt ? control.attempt?.id : undefined;
    if (!options.preserveAttempt) control.attempt = null;
    const halted = control.queue.filter(
      (entry) =>
        entry.id !== preserved &&
        (entry.status === "queued" || entry.status === "sending" || entry.status === "accepted"),
    );
    if (halted.length === 0) return;
    control.queue = control.queue.map((entry) => {
      if (entry.id === preserved) return entry;
      if (entry.status === "queued") return { ...entry, status: "undelivered" };
      if (entry.status === "sending") return { ...entry, status: "uncertain" };
      if (entry.status === "accepted") return { ...entry, status: "boundary-unknown" };
      return entry;
    });
    for (const entry of control.queue) {
      if (!halted.some((pending) => pending.id === entry.id)) continue;
      this.#choices.setQueueStatus(control.sessionId, entry.id, entry.status);
    }
    this.#publish(control);
    if (!options.surface) return;
    for (const entry of control.queue) {
      if (halted.some((pending) => pending.id === entry.id))
        this.#surfaceEntry(control, entry, options.reason);
    }
  }

  /** A message a previous run left unsent is shown once the rebuilt transcript is there. */
  #surfaceStopped(control: TurnControl): void {
    for (const entry of control.queue) {
      if (
        entry.status === "undelivered" ||
        entry.status === "uncertain" ||
        entry.status === "boundary-unknown" ||
        entry.status === "boundary-unverified" ||
        entry.status === "uncertain-idle" ||
        entry.status === "accepted-idle"
      )
        this.#surfaceEntry(control, entry);
    }
  }

  /** Surfaces one queue entry by id, after a status change that the caller already made. */
  #surfaceQueued(control: TurnControl, id: string, reason?: string): void {
    const entry = control.queue.find((candidate) => candidate.id === id);
    if (entry !== undefined) this.#surfaceEntry(control, entry, reason);
  }

  #surfaceEntry(control: TurnControl, entry: ChatQueuedMessage, reason?: string): void {
    if (control.driver.timeline.closed) return;
    const recovery =
      control.scope.kind === "pi"
        ? " Stop and restart this session to check the reopened agent; this interrupts running work."
        : "";
    const text =
      entry.status === "uncertain"
        ? `This message may have reached the agent and was not sent again. Later turns are paused because its outcome is unknown.${recovery} ${entry.text}`
        : entry.status === "uncertain-idle"
          ? `The reopened agent reported idle. This message may have reached it and was not sent again; its outcome is unknown, and work it started may still have effects: ${entry.text}`
          : entry.status === "accepted-idle"
            ? `The reopened agent reported idle. This message was accepted, but how its earlier turn ended is unknown; work it started may still have effects: ${entry.text}`
            : entry.status === "boundary-unknown"
              ? `This message was accepted, but its turn boundary is unknown. Later turns are paused.${recovery} ${entry.text}`
              : entry.status === "boundary-unverified"
                ? `This message was accepted, but this agent's turn boundary cannot currently be confirmed. Later turns are paused.${recovery} ${entry.text}`
                : `This queued message was not sent: ${entry.text}${reason === undefined ? "" : ` (${reason})`}`;
    control.driver.timeline.put({ kind: "error", id: `chat:queue:${entry.id}`, text });
  }

  #surfaceError(control: TurnControl, id: string, text: string): void {
    if (control.driver.timeline.closed) return;
    control.driver.timeline.put({ kind: "error", id, text } satisfies ChatItem);
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
    // A live frontend answers whatever view the session currently shows: a `both-live` driver's
    // chat stays addressable while the main area shows its terminal (C1), and for a `handoff-only`
    // driver the two views cannot both exist, so this changes nothing there.
    const driver = this.#drivers.get(subject.sessionId);
    if (driver !== undefined && !driver.closed) return driver;
    if (subject.view !== "chat")
      throw new ChatUnavailableError("this session runs in a terminal, not in chat", "no-driver");
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

function turnUnconfirmed(): ChatUnavailableError {
  return new ChatUnavailableError(
    "A previous turn may still be running or a native terminal is attached. Later turns are paused until the boundary can be confirmed.",
    "turn-unconfirmed",
  );
}

function initialId(sessionId: string): string {
  return `initial:${sessionId}`;
}

/** What a live report says about one level: offered, freshly gone, or not yet confirmed. */
type LevelOffer = "offered" | "removed" | "unconfirmed";

/** The user-facing explanation of a selection part the live driver has not confirmed. */
function mentionOf(issue: ChatSelectionIssue): string {
  return issue.reason === "unavailable"
    ? `the model no longer offers the thinking level "${issue.level}"`
    : `the thinking level "${issue.level}" has not been confirmed by the running model`;
}

/** The model and level reports whose change may make a skipped selection applicable again. */
function offerSignatureOf(state: ChatSessionState): string {
  const models = state.models
    .map(
      (model) => `${model.provider ?? ""}/${model.id}:${(model.reasoningLevels ?? []).join(",")}`,
    )
    .join("|");
  return [
    state.model === null ? "" : `${state.model.provider ?? ""}/${state.model.id}`,
    state.reasoningStatus ?? "",
    state.reasoningLevels.join(","),
    models,
  ].join("#");
}

/**
 * The choice a queued message captures when the session has not made one: what the running
 * frontend has confirmed. `null` when the agent has reported no model, which is not a claim that
 * it runs one of Corral's.
 */
function appliedSelection(driver: ChatDriver): ChatModelSelection | null {
  const model = driver.state.model;
  if (model === null) return null;
  return {
    model: { provider: model.provider, id: model.id },
    level: driver.state.reasoning,
  };
}
