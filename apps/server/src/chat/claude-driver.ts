import type { ChatAnswer, ChatModelRef } from "@corral/protocol/chat";
import type { AgentState, ChatSendMode } from "@corral/protocol/rpc";
import {
  getSessionMessages as sdkGetSessionMessages,
  query as sdkQuery,
  type CanUseTool,
  type EffortLevel,
  type ModelInfo,
  type Options,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
  type SessionMessage,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  ChatModelUnsupportedError,
  ChatReasoningUnsupportedError,
  ChatRequestUnknownError,
  ChatUnavailableError,
  agentStatus,
  messageOf,
} from "./chat-errors.ts";
import type {
  ChatDriver,
  ChatDriverLaunch,
  ChatDriverRegistration,
  ChatTimeouts,
} from "./chat-driver.ts";
import { ClaudeProjection, type ClaudeAction } from "./claude-projection.ts";
import type { ChatTimeline } from "./timeline.ts";

/** What Claude's chat frontend is started with: the resolved launch and the deadlines. */
export interface ClaudeDriverRequest extends ChatDriverLaunch, ChatTimeouts {}

/** The claude this build's driver was written and measured against (2.1.316, plan C2). */
export const TESTED_CLAUDE_VERSION = "2.1.316";

/** How long `claude --version` may take before chat refuses rather than hanging. */
const VERSION_TIMEOUT_MS = 5000;

/**
 * The slice of `@anthropic-ai/claude-agent-sdk` this driver uses. It is a seam, not a wrapper: the
 * tests hand in a stub that journals what it was asked and scripts the messages, because the real
 * SDK needs the user's login and a model turn, and neither belongs in a suite.
 */
export interface ClaudeSdkQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  close(): void;
  setModel(model?: string): Promise<void>;
  applyFlagSettings(settings: { effortLevel?: EffortLevel | null }): Promise<void>;
  supportedModels(): Promise<ModelInfo[]>;
}

export interface ClaudeSdk {
  query(params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }): ClaudeSdkQuery;
  getSessionMessages(sessionId: string, options?: { dir?: string }): Promise<SessionMessage[]>;
}

/** The build's SDK, in the shape above. A test seam substitutes it; nothing else does. */
export const CLAUDE_SDK: ClaudeSdk = {
  query: sdkQuery,
  getSessionMessages: sdkGetSessionMessages,
};

/**
 * One Claude Code chat session through the Claude Agent SDK, `handoff-only`.
 *
 * The SDK runs the user's own `claude` (the launch's `command`, `[agents.claude].command` or
 * `PATH`): `pathToClaudeCodeExecutable` names it, the version gate refuses an untested install, and
 * the launch environment — `CLAUDE_CONFIG_DIR` included — is passed through, so the SDK uses the
 * user's login exactly as a terminal launch does and the TUI's `claude --resume <id>` continues
 * what chat wrote.
 *
 * - `start` names our id (`Options.sessionId`) or resumes it (`Options.resume`); history is rebuilt
 *   from `getSessionMessages` before any live frame is applied, and the task prompt is handed over
 *   only when that history has no user message (C1's P0 class).
 * - A `canUseTool` call becomes a `select` user request named after its `toolUseID`; the answer
 *   resolves that one promise once and replaces the item, and an expired or stopped request is
 *   denied so the CLI never waits on the server's silence.
 * - `setModel`/`setReasoning` reach `Query.setModel`/`Query.applyFlagSettings`, with the list and
 *   the levels from `supportedModels()`; anything the model does not take is refused with the
 *   contract's typed errors.
 * - `stop` closes the query (stdin EOF, the CLI exits in order), waits to the deadline, then kills
 *   the process group. The child is spawned through `spawnClaudeCodeProcess` so its pid can be
 *   recorded as the session's writer (`ChatWriterClaim`), which is what keeps a restarted server or
 *   a terminal handoff from starting a second writer.
 *
 * The transcript stays the agent's: Corral stores no history and exposes no transcript.
 */
export class ClaudeDriver implements ChatDriver {
  readonly timeline: ChatTimeline;
  readonly #request: ClaudeDriverRequest;
  readonly #sdk: ClaudeSdk;
  readonly #projection: ClaudeProjection;
  readonly #input = new PromptQueue();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  #query: ClaudeSdkQuery | undefined;
  #child: ChildProcess | undefined;
  #readyTimer: NodeJS.Timeout | undefined;
  #closed = false;
  #stopping = false;
  #aborting = false;
  #models: ModelInfo[] = [];
  #prepared = false;
  #buffered: SDKMessage[] = [];
  #initModel: string | null = null;
  #initEffort: string | null = null;
  #failureReason: string | undefined;
  #childExit: Promise<void> = Promise.resolve();
  #exited: Promise<void> = Promise.resolve();
  #resolveExited: (() => void) | undefined;

  constructor(request: ClaudeDriverRequest, sdk: ClaudeSdk = CLAUDE_SDK) {
    this.#request = request;
    this.#sdk = sdk;
    // The service's timeline, built from the reserved sequence floor (its start is not ours).
    this.timeline = request.timeline;
    this.#projection = new ClaudeProjection(this.timeline, {
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

  /** Starts the SDK and its consumer. Never throws: a refusal is `onExit` with its sentence. */
  start(): void {
    this.#exited = new Promise((settle) => (this.#resolveExited = settle));
    this.#readyTimer = setTimeout(
      () => this.#fail(`claude did not answer within ${seconds(this.#request.readyTimeoutMs)}`),
      Math.max(1, this.#request.readyTimeoutMs),
    );
    void this.#open();
  }

  /** Version gate, then the SDK query and its reader. The gate runs first: an untested CLI never
   * starts, so no transcript is created and no half-supported option is sent. */
  async #open(): Promise<void> {
    const id = this.#request.agentSessionId;
    if (id === null) {
      this.#finish("the claude session has no id; a chat launch needs the conversation it names");
      return;
    }
    let version: string;
    try {
      version = await this.#installedVersion();
    } catch (error) {
      this.#finish(messageOf(error));
      return;
    }
    if (this.#closed || this.#stopping) return;
    if (version !== TESTED_CLAUDE_VERSION) {
      this.#finish(
        `the installed claude is ${version}; this Corral build runs Claude chat on ${TESTED_CLAUDE_VERSION}. ` +
          "Chat is unavailable for this version — the session can still run in the terminal.",
      );
      return;
    }
    let query: ClaudeSdkQuery;
    try {
      query = this.#sdk.query({ prompt: this.#input, options: this.#options(id) });
    } catch (error) {
      this.#finish(`claude refused the chat session: ${messageOf(error)}`);
      return;
    }
    if (this.#closed || this.#stopping) {
      // A stop that raced the spawn: close what exists rather than leaving a reader behind.
      try {
        query.close();
      } catch {
        // Nothing to close; the frontend is already reported gone.
      }
      return;
    }
    this.#query = query;
    void this.#read(query);
    // Preparation does not wait for `system:init`: the CLI emits that frame with the first turn, so
    // a launch that waited for it before sending the task prompt would deadlock. `supportedModels()`
    // and the transcript are answerable now (measured without a turn, `.e2e/stage-c/c2/probe/`).
    void this.#prepare();
  }

  /** `claude --version` through the effective executable, parsed to the version it reports. */
  async #installedVersion(): Promise<string> {
    const command = this.#request.command;
    const output = await new Promise<string>((settle, reject) => {
      execFile(
        command,
        ["--version"],
        { env: this.#request.env, timeout: VERSION_TIMEOUT_MS },
        (error, stdout, stderr) => {
          if (error !== null) {
            reject(new Error(claudeVersionError(command, error, stderr)));
            return;
          }
          settle(`${stdout}${stderr}`);
        },
      );
    });
    const version = claudeVersionOf(output);
    if (version === null) {
      throw new Error(
        `could not read the version of the claude at ${command}; this Corral build runs chat on ${TESTED_CLAUDE_VERSION}`,
      );
    }
    return version;
  }

  /** The SDK options a launch sends: the executable, the environment, the id and the approvals. */
  #options(id: string): Options {
    const options: Options = {
      cwd: this.#request.cwd,
      env: this.#request.env,
      pathToClaudeCodeExecutable: this.#request.command,
      includePartialMessages: true,
      // Never `bypassPermissions`: every tool the CLI would ask about becomes a user request.
      permissionMode: "default",
      canUseTool: (toolName, input, context) => this.#ask(toolName, input, context),
      spawnClaudeCodeProcess: (spawnOptions) => this.#spawn(spawnOptions),
      // `settingSources` stays default (goal D10 rule for C2 decision d): the user's settings and
      // CLAUDE.md apply, because chat and the terminal must see one environment.
    };
    if (this.#request.model !== null) options.model = this.#request.model;
    // A start names our UUID; a resume continues the recorded one.
    if (this.#request.how === "resume") options.resume = id;
    else options.sessionId = id;
    return options;
  }

  /**
   * Spawns the CLI the SDK asked for, in its own process group, and records its pid as this
   * session's writer. The SDK's transport still owns stdin/stdout, the exit listener and close();
   * this hook exists so the one-writer record knows the process, and so a stop can kill its group.
   */
  #spawn(options: SpawnOptions): SpawnedProcess {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.#child = child;
    this.#childExit = new Promise((settle) => child.once("exit", () => settle()));
    if (child.pid !== undefined) this.#request.writer.record(child.pid);
    // Diagnostics are drained, never logged: stderr may repeat a prompt or a credential.
    child.stderr?.resume();
    // The SDK's forwarded signal fires only after its own stdin-EOF grace; killing the group then
    // takes the tools the CLI started with it, which a bare `child.kill()` would leave behind.
    options.signal.addEventListener("abort", () => this.#kill(), { once: true });
    // `stdio: ["pipe", "pipe", "pipe"]` above gives the SDK the streams its SpawnedProcess
    // interface requires; Node's own type only knows that when the tuple is inferred, so the
    // runtime guarantee is stated here.
    return child;
  }

  /** Stops the frontend in order: no request waits, stdin closes, the group is killed if it must. */
  async stop(): Promise<void> {
    if (this.#closed) {
      await this.#exited;
      return;
    }
    this.#stopping = true;
    this.#aborting = true;
    this.#projection.expireAll();
    this.#clearTimers();
    this.#input.end();
    const query = this.#query;
    try {
      query?.close();
    } catch {
      // Already closed; the child's exit is what the waits below observe.
    }
    const child = this.#child;
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = await this.#withinExitGrace();
      if (!exited) {
        this.#kill();
        // SIGKILL to the group is immediate; waiting for the exit is what lets the writer record
        // be released rather than kept for a process that is already dying.
        await this.#withinExitGrace();
      }
    }
    if (!this.#closed) this.#finish(null);
    // The reader can finish while the child is still exiting (stdin closed, exit pending), and
    // `#finish` keeps a live process's record on purpose. The stop outlives the exit, so it is the
    // place that releases a record this frontend still owns; a relaunch cannot race it because
    // `ChatService.stop` is awaited before the next launch.
    if (child !== undefined && child.exitCode !== null) this.#request.writer.release();
    await this.#exited;
  }

  /** Sends the user's message and returns the id of the item it became. */
  send(text: string, mode: ChatSendMode): string {
    if (this.#closed) throw this.#unavailable();
    const itemId = this.#projection.userMessage(text);
    this.#aborting = false;
    // `priority` is the SDK's own queue: "now" for a steer, "later" for a follow-up, "next" for a
    // prompt sent while a turn runs. The CLI folds a queued message into the running turn, so none
    // of the three is a second writer on the conversation.
    this.#input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      priority: mode === "steer" ? "now" : mode === "follow-up" ? "later" : "next",
    });
    this.timeline.setState({ turn: "working" });
    this.#report({ state: "working" });
    return itemId;
  }

  /** Interrupts the running turn; a request waiting for an answer is expired first. */
  async abort(): Promise<void> {
    if (this.#closed || this.#query === undefined) return;
    this.#aborting = true;
    this.#projection.expireAll();
    this.#clearTimers();
    try {
      await this.#query.interrupt();
    } catch (error) {
      if (this.#closed) return;
      this.#projection.error(`claude did not accept the interrupt: ${messageOf(error)}`);
      this.#report({ state: "error" });
    }
  }

  /** Answers one permission request; throws when it is not waiting for an answer. */
  respond(itemId: string, value: ChatAnswer): void {
    if (!this.#projection.answer(itemId, value)) throw new ChatRequestUnknownError(itemId);
    this.#clearTimer(itemId);
    this.#report({ state: "working" });
  }

  async setModel(model: ChatModelRef): Promise<void> {
    const query = this.#liveQuery();
    const entry = this.#projection.model(model.id);
    if (entry === undefined) {
      throw new ChatModelUnsupportedError(model, `claude does not offer the model ${model.id}`);
    }
    try {
      await query.setModel(entry.id);
    } catch (error) {
      if (this.#closed) throw this.#unavailable();
      throw new ChatModelUnsupportedError(model, messageOf(error));
    }
    this.#projection.activateModel(entry.id);
  }

  async setReasoning(level: string): Promise<void> {
    const query = this.#liveQuery();
    const levels = this.timeline.state.reasoningLevels;
    if (!levels.includes(level)) {
      throw new ChatReasoningUnsupportedError(
        level,
        levels.length === 0
          ? `claude's ${this.timeline.state.model?.name ?? "model"} takes no effort level`
          : `claude's ${this.timeline.state.model?.name ?? "model"} takes ${levels.join(", ")}`,
      );
    }
    if (!isEffortLevel(level)) {
      throw new ChatReasoningUnsupportedError(level, `${level} is not a claude effort level`);
    }
    try {
      await query.applyFlagSettings({ effortLevel: level });
    } catch (error) {
      if (this.#closed) throw this.#unavailable();
      throw new ChatReasoningUnsupportedError(level, messageOf(error));
    }
    this.#projection.activateReasoning(level);
  }

  #liveQuery(): ClaudeSdkQuery {
    if (this.#closed || this.#query === undefined) throw this.#unavailable();
    return this.#query;
  }

  /** Consumes the SDK's messages until the frontend ends; the single reader of the query. */
  async #read(query: ClaudeSdkQuery): Promise<void> {
    try {
      for await (const message of query) {
        if (this.#closed) return;
        this.#onMessage(message);
      }
      this.#finish(this.#stopping ? null : (this.#failureReason ?? "claude exited"));
    } catch (error) {
      if (this.#stopping || this.#closed) {
        this.#finish(null);
        return;
      }
      this.#fail(messageOf(error));
    }
  }

  #onMessage(message: SDKMessage): void {
    if (message.type === "system" && message.subtype === "init") this.#init(message);
    if (!this.#prepared) {
      this.#buffered.push(message);
      return;
    }
    this.#apply(message);
  }

  /**
   * The CLI's own report of the session: the model it resolved and the effort it applies. It
   * arrives with the first turn, so it updates the list the launch already read rather than being
   * the signal that preparation may start.
   */
  #init(message: Extract<SDKMessage, { type: "system"; subtype: "init" }>): void {
    this.#initModel = message.model;
    this.#initEffort = message.effort ?? null;
    if (this.#prepared) {
      // A level the user set before the first turn survives the frame when the model still takes
      // it: `init.effort` is the CLI's own reading, and it may not have echoed a session overlay.
      this.#projection.setModels(
        this.#models,
        this.#initModel,
        this.#initEffort ?? this.timeline.state.reasoning,
      );
    }
  }

  /**
   * Rebuilds the timeline from the transcript, then replays what arrived while it was loading and
   * hands the task prompt over only to a conversation with no user message.
   */
  async #prepare(): Promise<void> {
    const query = this.#query;
    const id = this.#request.agentSessionId;
    if (query === undefined || id === null) return;
    let models: ModelInfo[];
    try {
      models = await query.supportedModels();
    } catch (error) {
      this.#fail(`claude did not list its models: ${messageOf(error)}`);
      return;
    }
    if (this.#closed) return;
    this.#models = models;
    this.#projection.setModels(models, this.#initModel ?? this.#request.model, this.#initEffort);
    let history: SessionMessage[] | null = null;
    try {
      // No `dir`: the transcript's project directory is a slug scheme that is not ours (the
      // terminal leg searches all of them for the same reason, `agents/claude.ts`). A narrowed
      // read can answer `[]` for a conversation that exists, which would resend the task prompt.
      history = await this.#sdk.getSessionMessages(id);
    } catch {
      // Unreadable history must never be mistaken for an empty one: that would resend the prompt.
      history = null;
    }
    if (this.#closed) return;
    if (history !== null) this.#projection.loadHistory(history);
    this.#clearReadyTimer();
    this.#prepared = true;
    // A resumed conversation with no prompt to send reports the session as ready here; a launch
    // that does send its prompt reports "working" from `send`, and a message the user sent while
    // preparation ran must not be reported idle.
    if (this.timeline.state.turn !== "working") this.#report({ state: "idle" });
    for (const message of this.#buffered.splice(0)) this.#apply(message);
    this.#sendPromptIfNeeded(history);
  }

  /**
   * The launch's candidate prompt, handed over only when the rebuilt conversation has no user
   * message. When the history could not be rebuilt — the read failed, or the launch's
   * `CLAUDE_CONFIG_DIR` is not the one the in-process SDK reads — nothing is sent and a notice says
   * why: a duplicate prompt does the task twice, which is worse than typing it once more.
   */
  #sendPromptIfNeeded(history: SessionMessage[] | null): void {
    const prompt = this.#request.prompt;
    if (prompt === null) return;
    const hasUser = this.timeline.snapshot().items.some((item) => item.kind === "user-message");
    if (hasUser) return;
    if (history === null || !historyIsReadable(this.#request.env)) {
      this.#projection.notice(
        "The Claude conversation could not be rebuilt, so the task prompt was not sent again. Send it here if the conversation is empty.",
      );
      return;
    }
    this.send(prompt, "prompt");
  }

  /** One `canUseTool`: ask the user, with the server's own deadline beside the CLI's signal. */
  #ask(
    toolName: string,
    input: Record<string, unknown>,
    context: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    if (this.#closed || this.#stopping) {
      return Promise.resolve({
        behavior: "deny",
        message: "The chat frontend stopped.",
        decisionClassification: "user_reject",
      });
    }
    const { itemId, result } = this.#projection.openPermission({
      toolUseID: context.toolUseID,
      name: toolName,
      input,
      title: context.title,
      description: context.description,
      suggestions: context.suggestions,
      blockedPath: context.blockedPath,
    });
    const timer = setTimeout(
      () => {
        if (this.#projection.expire(itemId)) {
          this.#clearTimer(itemId);
          this.#report({ state: "working" });
        }
      },
      Math.max(1, this.#request.dialogTimeoutMs),
    );
    timer.unref();
    this.#timers.set(itemId, timer);
    context.signal.addEventListener(
      "abort",
      () => {
        if (!this.#projection.expire(itemId)) return;
        this.#clearTimer(itemId);
        this.#report({ state: this.#aborting ? "idle" : "working" });
      },
      { once: true },
    );
    this.#report({ state: "blocked", kind: "question" });
    return result;
  }

  #apply(message: SDKMessage): void {
    // A result after an interrupt says the turn ended; the user's abort, not the CLI's own
    // bookkeeping, is what the timeline shows.
    if (message.type === "result" && this.#aborting) {
      this.#aborting = false;
      this.#projection.aborted();
      this.#clearTimers();
      this.#report({ state: "idle" });
      return;
    }
    for (const action of this.#projection.apply(message)) this.#runAction(action);
  }

  #runAction(action: ClaudeAction): void {
    if (action.type === "status") {
      this.#report(action);
      return;
    }
    if (action.type === "request-closed") this.#clearTimer(action.itemId);
  }

  #report(action: { state: AgentState; kind?: "question"; message?: string }): void {
    const extra: { kind?: "question"; message?: string } = {};
    if (action.kind !== undefined) extra.kind = action.kind;
    if (action.message !== undefined) extra.message = action.message;
    this.#request.onStatus(agentStatus(action.state, Date.now(), extra));
  }

  #clearTimer(itemId: string): void {
    const timer = this.#timers.get(itemId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#timers.delete(itemId);
  }

  #clearTimers(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  #clearReadyTimer(): void {
    if (this.#readyTimer === undefined) return;
    clearTimeout(this.#readyTimer);
    this.#readyTimer = undefined;
  }

  /** The frontend is gone, or was never started: stop streaming, say why, free the writer. */
  #finish(reason: string | null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopping = true;
    this.#clearReadyTimer();
    this.#clearTimers();
    this.#input.end();
    this.#projection.expireAll();
    if (reason !== null) {
      this.#request.onStatus(agentStatus("error", Date.now(), { message: reason }));
      this.#projection.fail(reason);
    } else {
      // A clean stop still ends the partial text: a frontend that is gone is not mid-word.
      this.#projection.stopped();
    }
    const child = this.#child;
    // A process that outlives the driver keeps its record: `releasePreviousWriter` stops or awaits
    // it on the next launch and removes a record whose pid is gone. Releasing it from this driver
    // when it finally exits would delete a newer launch's record, which is the same record path.
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      this.#request.writer.release();
    }
    this.timeline.close();
    this.#resolveExited?.();
    this.#request.onExit(reason);
  }

  /** Ends the frontend with a visible reason, killing the group if it is still there. */
  #fail(reason: string): void {
    if (this.#closed || this.#stopping) return;
    this.#failureReason ??= reason;
    const child = this.#child;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      this.#finish(this.#failureReason);
      return;
    }
    this.#kill();
    const timer = setTimeout(
      () => this.#finish(this.#failureReason ?? reason),
      Math.max(1, this.#request.exitGraceMs),
    );
    timer.unref();
  }

  #kill(): void {
    const pid = this.#child?.pid;
    try {
      if (process.platform !== "win32" && pid !== undefined) {
        process.kill(-pid, "SIGKILL");
        return;
      }
    } catch {
      // The group is gone; the child handle still knows how to stop it.
    }
    this.#child?.kill("SIGKILL");
  }

  /** Waits for the child process to exit within the stop's grace; false when it did not. */
  async #withinExitGrace(): Promise<boolean> {
    return Promise.race([
      this.#childExit.then(() => true),
      new Promise<boolean>((settle) =>
        setTimeout(() => settle(false), Math.max(1, this.#request.exitGraceMs)).unref(),
      ),
    ]);
  }

  #unavailable(): ChatUnavailableError {
    return new ChatUnavailableError(
      this.#failureReason ?? "the chat frontend is not running",
      "exited",
    );
  }
}

/** The streaming input the SDK reads: user messages from `send`, ended by a stop. */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  #items: SDKUserMessage[] = [];
  #wake: (() => void) | undefined;
  #done = false;

  push(message: SDKUserMessage): void {
    if (this.#done) return;
    this.#items.push(message);
    this.#wake?.();
    this.#wake = undefined;
  }

  end(): void {
    this.#done = true;
    this.#wake?.();
    this.#wake = undefined;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage, void> {
    while (true) {
      const item = this.#items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.#done) return;
      // oxlint-disable-next-line no-await-in-loop -- one queued message per iteration is the point
      await new Promise<void>((settle) => (this.#wake = settle));
    }
  }
}

/**
 * Why the version could not be read: a command that never answered is the version deadline, not a
 * generic spawn failure, so the refusal says how long chat waited.
 */
export function claudeVersionError(
  command: string,
  error: { message: string; killed?: boolean; signal?: NodeJS.Signals | null },
  stderr: string,
): string {
  if (error.killed === true || (error.signal !== undefined && error.signal !== null)) {
    return `the claude at ${command} did not answer --version within ${Math.round(VERSION_TIMEOUT_MS / 1000)} s`;
  }
  const detail = stderr === "" ? "" : ` (${stderr.trim()})`;
  return `could not run ${command} --version: ${messageOf(error)}${detail}`;
}

/** The version `claude --version` printed (`2.1.316 (Claude Code)`), or null. */
export function claudeVersionOf(output: string): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(output);
  return match?.[1] ?? null;
}

/**
 * Whether the in-process SDK reads the same config directory this launch uses. `getSessionMessages`
 * resolves `CLAUDE_CONFIG_DIR` from the server's own environment; a profile that points a launch
 * elsewhere would make an empty read look like an empty conversation, so that case must not prompt.
 */
export function historyIsReadable(
  launchEnv: Record<string, string>,
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return configDirOf(launchEnv) === configDirOf(processEnv);
}

function configDirOf(env: Record<string, string | undefined>): string {
  const explicit = env["CLAUDE_CONFIG_DIR"];
  if (explicit !== undefined && explicit !== "") return resolve(explicit);
  const home = env["HOME"];
  return resolve(home !== undefined && home !== "" ? home : homedir(), ".claude");
}

/** Claude's own effort vocabulary; `chat.setReasoning` accepts only one of these. */
function isEffortLevel(level: string): level is EffortLevel {
  return (
    level === "low" ||
    level === "medium" ||
    level === "high" ||
    level === "xhigh" ||
    level === "max"
  );
}

function seconds(milliseconds: number): string {
  return `${Math.max(1, Math.round(milliseconds / 1000))} s`;
}

/**
 * Claude's chat argv. The SDK is the chat frontend, so the driver has no argv of its own: the TUI
 * leg is the agent adapter's `--resume`.
 */
function claudeChatArgs(): string[] {
  return [];
}

/**
 * Claude Code as a chat driver. `handoff-only` is the measured fact (`design.md`, **Terminal and
 * chat**): the SDK and the TUI cannot attach to one session at once, so `prefix v` keeps B4's
 * serial stop-and-start and the terminal leg is `claude --resume <id>`.
 */
export const claudeChatDriver: ChatDriverRegistration = {
  capabilities: {
    steer: true,
    followUp: true,
    approvals: true,
    modelSwitch: true,
    reasoningLevels: true,
    terminalView: "handoff-only",
  },
  args: claudeChatArgs,
  create: (launch) => new ClaudeDriver(launch),
};
