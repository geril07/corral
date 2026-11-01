import type { ChatAnswer, ChatModelRef, ChatSessionState } from "@corral/protocol/chat";
import type { ChatSendMode } from "@corral/protocol/rpc";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  ChatModelUnsupportedError,
  ChatReasoningUnsupportedError,
  ChatRequestUnknownError,
  ChatUnavailableError,
  PiCommandError,
  agentStatus,
  messageOf,
} from "./chat-errors.ts";
import { PiProjection, type PiAction } from "./pi-projection.ts";
import { pi } from "../agents/pi.ts";
import type {
  ChatDriver,
  ChatDriverLaunch,
  ChatDriverRegistration,
  ChatLaunchFacts,
  ChatTimeouts,
} from "./chat-driver.ts";
import {
  PiLineReader,
  command,
  objectField,
  recordsField,
  stringField,
  stringsField,
  typeOf,
  type PiRecord,
} from "./pi-record.ts";
import { ChatTimeline } from "./timeline.ts";
import { recordWriter, releaseWriter } from "./writer-claim.ts";

/** What pi's chat frontend is started with: the resolved launch and the supervision deadlines. */
export interface PiDriverRequest extends ChatDriverLaunch, ChatTimeouts {}

/**
 * One chat session's live frontend: the pi RPC child, the JSONL client (hand-written against
 * `pi --mode rpc`, no pi dependency), and the chat timeline the contract streams.
 *
 * Framing and lifecycle follow pi's documented rules: only LF ends a record, stdout is read
 * continuously, commands carry ids their responses repeat, stderr is drained and discarded,
 * and stdin honours backpressure. Supervision follows the naming run: an own process group,
 * the group killed on stop, and the pid recorded so a restarted server never leaves two writers
 * on one pi session.
 */
export class PiDriver implements ChatDriver {
  readonly timeline: ChatTimeline;
  readonly #request: PiDriverRequest;
  readonly #projection: PiProjection;
  readonly #reader = new PiLineReader();
  readonly #pending = new Map<
    string,
    { command: string; resolve: (data: PiRecord) => void; reject: (error: Error) => void }
  >();
  readonly #dialogTimers = new Map<string, NodeJS.Timeout>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #commandCounter = 0;
  #writes: Promise<void> = Promise.resolve();
  #stdinEnded = false;
  #readyTimer: NodeJS.Timeout | undefined;
  #closed = false;
  #stopping = false;
  #failureReason: string | undefined;
  #exited: Promise<void> = Promise.resolve();
  #resolveExited: (() => void) | undefined;

  constructor(request: PiDriverRequest) {
    this.#request = request;
    this.timeline = new ChatTimeline(request.startAt);
    this.#projection = new PiProjection(this.timeline, {
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

  /** Spawns the child and starts loading its history and session state. Never throws for the spawn. */
  start(): void {
    this.#exited = new Promise((resolve) => (this.#resolveExited = resolve));
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.#request.command, this.#request.args, {
        cwd: this.#request.cwd,
        env: this.#request.env,
        stdio: ["pipe", "pipe", "pipe"],
        // Its own process group, so stopping it stops the tools and extensions it started too.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      this.#finish(`could not start ${this.#request.command}: ${messageOf(error)}`);
      return;
    }
    this.#child = child;
    if (child.pid !== undefined) recordWriter(this.#request.claimPath, child.pid);
    child.stdin.on("error", () => {
      // The child stopped reading: treated like a closed stdin, not an uncaught stream error.
      this.#stdinEnded = true;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    // Drained, never logged: stderr is diagnostics and may repeat a prompt or a credential.
    child.stderr.resume();
    child.once("error", (error) =>
      this.#finish(`could not start ${this.#request.command}: ${messageOf(error)}`),
    );
    // `close`, not `exit`: it also fires when the spawn itself failed (no pid, no exit).
    child.once("close", (code, signal) => this.#onClose(code, signal));
    this.#readyTimer = setTimeout(
      () => this.#fail(`pi did not answer within ${seconds(this.#request.readyTimeoutMs)}`),
      Math.max(1, this.#request.readyTimeoutMs),
    );
    void this.#prepare();
  }

  /**
   * Stops the child the way the naming run stops its own: stop waiting on dialogs, close stdin
   * (pi exits in order, and on pi 1.4.0 even mid-turn), wait to the deadline, then kill the group.
   */
  async stop(): Promise<void> {
    if (this.#closed) {
      await this.#exited;
      return;
    }
    this.#stopping = true;
    for (const itemId of this.#projection.expireAll()) this.#cancelDialog(itemId);
    this.#rejectPending("the chat frontend stopped");
    const child = this.#child;
    if (child === undefined || child.exitCode !== null) {
      this.#finish(null);
      await this.#exited;
      return;
    }
    this.#stdinEnded = true;
    try {
      child.stdin.end();
    } catch {
      // Already closed; the exit handler decides what happens next.
    }
    const exited = await this.#waitForClose();
    if (!exited) {
      this.#kill();
      const killed = await this.#waitForClose();
      // SIGKILL to the group is immediate; a process that outlives it is abandoned, and its
      // recorded pid stays so the next start stops it before spawning another writer.
      if (!killed) this.#finish(this.#failureReason ?? null);
    }
    await this.#exited;
  }

  /** Sends the user's message and returns the id of the item it became. */
  send(text: string, mode: ChatSendMode): string {
    const itemId = this.#projection.userMessage(text);
    const type = mode === "steer" ? "steer" : mode === "follow-up" ? "follow_up" : "prompt";
    void this.#requestCommand(type, { message: text }).catch((error: unknown) => {
      // The words are in the timeline; the failure is a visible error next to them, not a lost send.
      this.#projection.rejectedCommand(`pi did not accept the message: ${messageOf(error)}`);
    });
    return itemId;
  }

  /** Stops the turn; pending dialogs are cancelled first so an abort cannot wait on one forever. */
  async abort(): Promise<void> {
    for (const itemId of this.#projection.expireAll()) this.#cancelDialog(itemId);
    await this.#requestCommand("abort");
  }

  /** Answers a pending request; throws when the item is not waiting for an answer. */
  respond(itemId: string, value: ChatAnswer): void {
    const response = this.#projection.respond(itemId, value);
    if (response === undefined) throw new ChatRequestUnknownError(itemId);
    this.#clearDialogTimer(itemId);
    void this.#write(response).catch(() => undefined);
    this.#request.onStatus(agentStatus("working", Date.now()));
  }

  async setModel(model: ChatModelRef): Promise<void> {
    const provider = model.provider ?? this.timeline.state.model?.provider;
    if (provider === null || provider === undefined) {
      throw new ChatModelUnsupportedError(model, `pi needs a provider for model ${model.id}`);
    }
    const data = await this.#requestCommand("set_model", { provider, modelId: model.id }).catch(
      (error: unknown) => {
        // A dead frontend is CHAT_UNAVAILABLE, not an unsupported model.
        if (error instanceof ChatUnavailableError) throw error;
        throw new ChatModelUnsupportedError(model, messageOf(error));
      },
    );
    this.timeline.setState({
      model: {
        provider,
        id: typeof data["id"] === "string" ? data["id"] : model.id,
        name: typeof data["name"] === "string" ? data["name"] : model.id,
      },
    });
    // pi's thinking levels belong to the model in effect (`xhigh`/`max` appear only where the
    // model supports them), so the level and the accepted list are re-read after the switch. The
    // model change itself has succeeded: a failed refresh must not report it as refused, and a
    // dead frontend surfaces on the next command.
    try {
      await this.#refreshModelState();
    } catch {
      // Keep the switched model. The refresh runs only from this method, so a failure leaves the
      // previous model's level list for the rest of the session unless another model switch (or a
      // restart) re-reads it.
    }
  }

  /** What the model in effect reports about reasoning: the level it runs at and the levels it takes. */
  async #refreshModelState(): Promise<void> {
    const [state, levels] = await Promise.all([
      this.#requestCommand("get_state"),
      this.#requestCommand("get_available_thinking_levels"),
    ]);
    if (this.#closed) return;
    this.timeline.setState({
      reasoning: stringField(state, "thinkingLevel") ?? null,
      reasoningLevels: stringsField(levels, "levels"),
    });
  }

  async setReasoning(level: string): Promise<void> {
    await this.#requestCommand("set_thinking_level", { level }).catch((error: unknown) => {
      if (error instanceof ChatUnavailableError) throw error;
      throw new ChatReasoningUnsupportedError(level, messageOf(error));
    });
    this.timeline.setState({ reasoning: level });
  }

  /** The start-up commands whose answers rebuild the chat from pi, then the first prompt. */
  async #prepare(): Promise<void> {
    try {
      const [state, models, levels, messages] = await Promise.all([
        this.#requestCommand("get_state"),
        this.#requestCommand("get_available_models"),
        this.#requestCommand("get_available_thinking_levels"),
        this.#requestCommand("get_messages"),
      ]);
      if (this.#closed) return;
      this.#clearReadyTimer();
      this.#projection.loadModelState(
        state,
        recordsField(models, "models"),
        stringsField(levels, "levels"),
      );
      const history = recordsField(messages, "messages");
      this.#projection.loadHistory(history);
      // The task's prompt is the work a chat task was made for. pi's own history decides whether
      // this is the first start: a conversation that already has a user message is resumed, so the
      // prompt is never handed over twice, and a start that died before pi wrote it hands it over.
      const firstStart = !history.some((message) => message["role"] === "user");
      if (firstStart && this.#request.prompt !== null) this.send(this.#request.prompt, "prompt");
    } catch (error) {
      this.#fail(messageOf(error));
    }
  }

  #onStdout(chunk: string): void {
    if (this.#closed) return;
    let records: PiRecord[];
    try {
      records = this.#reader.push(chunk);
    } catch (error) {
      this.#fail(messageOf(error));
      return;
    }
    for (const record of records) this.#onRecord(record);
  }

  #onRecord(record: PiRecord): void {
    if (typeOf(record) === "response") {
      this.#onResponse(record);
      return;
    }
    for (const action of this.#projection.apply(record)) this.#runAction(action);
  }

  #onResponse(record: PiRecord): void {
    const id = record["id"];
    if (typeof id !== "string") return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    if (record["success"] === true) {
      pending.resolve(objectField(record, "data") ?? {});
    } else {
      const detail = record["error"];
      pending.reject(
        new PiCommandError(pending.command, typeof detail === "string" ? detail : "unknown error"),
      );
    }
  }

  #runAction(action: PiAction): void {
    switch (action.type) {
      case "status": {
        const extra: { kind?: "question"; message?: string } = {};
        if (action.kind !== undefined) extra.kind = action.kind;
        if (action.message !== undefined) extra.message = action.message;
        this.#request.onStatus(agentStatus(action.state, Date.now(), extra));
        return;
      }
      case "dialog-opened": {
        this.#clearDialogTimer(action.itemId);
        const delay = Math.max(0, action.expiresAt - Date.now());
        const timer = setTimeout(() => this.#expire(action.itemId), delay);
        timer.unref();
        this.#dialogTimers.set(action.itemId, timer);
        return;
      }
      case "dialog-closed":
        this.#clearDialogTimer(action.itemId);
        return;
    }
  }

  /** The server's own deadline for a request pi's extension left open. */
  #expire(itemId: string): void {
    const expired = this.#projection.expire(itemId);
    this.#clearDialogTimer(itemId);
    if (expired === undefined) return;
    this.#cancelDialog(expired.piRequestId);
    this.#request.onStatus(agentStatus("working", Date.now()));
  }

  /** Tells pi its dialog is dismissed, so the extension stops waiting for an answer. */
  #cancelDialog(piRequestId: string): void {
    // Best effort: the child may already have closed, and a dialog nobody waits on is harmless.
    void this.#write({ type: "extension_ui_response", id: piRequestId, cancelled: true }).catch(
      () => undefined,
    );
  }

  #clearDialogTimer(itemId: string): void {
    const timer = this.#dialogTimers.get(itemId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#dialogTimers.delete(itemId);
  }

  #requestCommand(type: string, fields: Record<string, unknown> = {}): Promise<PiRecord> {
    if (this.#closed) return Promise.reject(this.#unavailable());
    const id = `c${(this.#commandCounter += 1)}`;
    const answer = new Promise<PiRecord>((resolve, reject) => {
      this.#pending.set(id, { command: type, resolve, reject });
    });
    void this.#write(command(id, type, fields)).catch((error: unknown) => {
      const pending = this.#pending.get(id);
      this.#pending.delete(id);
      pending?.reject(error instanceof Error ? error : new PiCommandError(type, messageOf(error)));
    });
    return answer;
  }

  /** One command on stdin, in order; waits for `drain` rather than buffering without bound. */
  #write(record: PiRecord): Promise<void> {
    const stdin = this.#child?.stdin;
    if (stdin === undefined || stdin.destroyed || this.#closed || this.#stdinEnded)
      return Promise.reject(this.#unavailable());
    const line = `${JSON.stringify(record)}\n`;
    // `then(run, run)`: one failed write must not leave the chain rejected for every later command.
    const run = () =>
      new Promise<void>((resolve, reject) => {
        if (stdin.destroyed || this.#stdinEnded || this.#closed) {
          reject(this.#unavailable());
          return;
        }
        let flushed: boolean;
        try {
          flushed = stdin.write(line, (error) => {
            if (error) reject(error);
          });
        } catch (error) {
          this.#stdinEnded = true;
          reject(error instanceof Error ? error : this.#unavailable());
          return;
        }
        if (flushed) {
          resolve();
          return;
        }
        // Backpressure: wait for the buffer to drain; a pipe that closes settles the write too.
        const settle = () => {
          stdin.off("drain", settle);
          stdin.off("close", settle);
          resolve();
        };
        stdin.once("drain", settle);
        stdin.once("close", settle);
      });
    this.#writes = this.#writes.then(run, run);
    return this.#writes;
  }

  #onClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#closed) return;
    // Flush what did not end in LF: a truncated record is a parse failure the user should see,
    // not a silently dropped event (and not a clean exit either).
    let tail: PiRecord[] = [];
    try {
      tail = this.#reader.finish();
    } catch (error) {
      this.#failureReason ??= messageOf(error);
    }
    for (const record of tail) this.#onRecord(record);
    // A stop the server asked for has no reason to report, whatever failed on the way out.
    const reason = this.#stopping
      ? null
      : (this.#failureReason ?? `pi exited unexpectedly (${exitOf(code, signal)})`);
    this.#finish(reason);
  }

  /**
   * The child is gone, or was never started: stop streaming, say why, end the watches and tell
   * the session service. Every path out of the driver goes through here exactly once.
   */
  #finish(reason: string | null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stdinEnded = true;
    this.#clearReadyTimer();
    for (const itemId of this.#dialogTimers.keys()) this.#clearDialogTimer(itemId);
    this.#rejectPending(reason ?? "the chat frontend stopped");
    if (reason !== null) {
      // A failed frontend reports `error`, which outlives the process, so the sidebar and the
      // stopped-session pane say what happened instead of falling back to "no status".
      this.#request.onStatus(agentStatus("error", Date.now(), { message: reason }));
      this.#projection.fail(reason);
    }
    this.#projection.expireAll();
    // An abandoned process may still write the session file; its record is what stops the next one.
    if (
      this.#child === undefined ||
      this.#child.exitCode !== null ||
      this.#child.signalCode !== null
    )
      releaseWriter(this.#request.claimPath);
    this.timeline.close();
    this.#resolveExited?.();
    this.#request.onExit(reason);
  }

  /** Ends the frontend with a visible reason, killing the child if it is still there. */
  #fail(reason: string): void {
    if (this.#closed || this.#stopping) return;
    this.#failureReason ??= reason;
    const child = this.#child;
    if (child === undefined || child.exitCode !== null) {
      this.#finish(this.#failureReason);
      return;
    }
    this.#kill();
    // A descendant holding the pipes open must not keep the session looking alive.
    const timer = setTimeout(() => this.#finish(this.#failureReason ?? reason), 2000);
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

  #waitForClose(): Promise<boolean> {
    return Promise.race([
      this.#exited.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), Math.max(1, this.#request.exitGraceMs)).unref(),
      ),
    ]);
  }

  #clearReadyTimer(): void {
    if (this.#readyTimer === undefined) return;
    clearTimeout(this.#readyTimer);
    this.#readyTimer = undefined;
  }

  #rejectPending(detail: string): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) entry.reject(new PiCommandError(entry.command, detail));
  }

  #unavailable(): ChatUnavailableError {
    return new ChatUnavailableError(
      this.#failureReason ?? "the chat frontend is not running",
      "exited",
    );
  }

  /** The session state the chat contract reports, for tests and the service. */
  get state(): ChatSessionState {
    return this.timeline.state;
  }
}

function exitOf(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) return `code ${code}`;
  return signal === null ? "no exit code" : `signal ${signal}`;
}

function seconds(milliseconds: number): string {
  return `${Math.max(1, Math.round(milliseconds / 1000))}s`;
}

/**
 * pi's chat argv: RPC mode, the profile's model and provider flags, and the session id. pi's
 * `--session-id` opens the conversation or creates it, so a resume and a start name the same flag;
 * there is no prompt argument, because RPC rejects the TUI's `@file` prompt shape — the prompt
 * travels as a `prompt` command once the child has said whether it has a conversation.
 */
export function piChatArgs(facts: ChatLaunchFacts): string[] {
  const id = facts.agentSessionId;
  return [
    "--mode",
    "rpc",
    ...pi.launchArgs(facts.model, facts.provider),
    ...(facts.how === "resume" && id !== null ? pi.resumeArgs(id) : pi.startArgs(id)),
  ];
}

/**
 * pi as one chat driver. Its terminal view is `handoff-only`: pi has no session-file lock, so a
 * chat frontend and a TUI on one session would corrupt the file (design.md, **Terminal and chat**).
 * Its dialogs are the contract's user requests, its events carry status, and the model in effect
 * reports the thinking levels it takes.
 */
export const piChatDriver: ChatDriverRegistration = {
  capabilities: {
    steer: true,
    followUp: true,
    approvals: true,
    modelSwitch: true,
    reasoningLevels: true,
    terminalView: "handoff-only",
  },
  args: piChatArgs,
  create: (launch) => new PiDriver(launch),
};
