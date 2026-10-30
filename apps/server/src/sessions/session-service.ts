import type {
  CreateTerminalInput,
  Session,
  SessionKind,
  Task,
  TerminalSize,
} from "@corral/protocol/rpc";
import { AGENTS } from "../agents/agents.ts";
import {
  codexHome,
  watchForCodexSession,
  type CodexSessionWatch,
} from "../agents/codex-sessions.ts";
import { isExecutable } from "../agents/executable-lookup.ts";
import { ChangeFeed } from "../changes/change-feed.ts";
import { newId } from "../storage/ids.ts";
import { TaskNotFoundError } from "../tasks/errors.ts";
import { SerialQueue } from "../tasks/serial-queue.ts";
import type { TaskStore } from "../tasks/task-store.ts";
import type { TerminalRegistry } from "../terminals/terminal-registry.ts";
import { AgentNotFoundError, AlreadyRunningError, SessionNotFoundError } from "./errors.ts";
import type { SessionStore, StoredSession } from "./session-store.ts";

/** Sessions started again after a server restart have no client to size them yet. */
const RESTORED_SIZE: TerminalSize = { cols: 80, rows: 24 };

/** The terminal a session runs in, and the search for the Codex id while there is none yet. */
interface Live {
  terminalId: string;
  discovery: CodexSessionWatch | undefined;
}

export class SessionService {
  readonly #store: SessionStore;
  readonly #tasks: TaskStore;
  readonly #terminals: TerminalRegistry;
  readonly #live = new Map<string, Live>();
  readonly #changes = new ChangeFeed();
  // Starting, stopping and removing wait for processes; one at a time keeps a session's steps in order.
  readonly #queue = new SerialQueue();
  #shuttingDown = false;

  constructor(options: { store: SessionStore; tasks: TaskStore; terminals: TerminalRegistry }) {
    this.#store = options.store;
    this.#tasks = options.tasks;
    this.#terminals = options.terminals;
  }

  list(): Session[] {
    return this.#store.list().map((stored) => this.#withTerminal(stored));
  }

  watch(signal: AbortSignal | undefined): AsyncGenerator<Session[]> {
    return this.#changes.watch(() => this.list(), signal);
  }

  start(taskId: string, kind: SessionKind, size: TerminalSize): Promise<Session> {
    return this.#queue.run(async () => {
      const task = this.#task(taskId);
      const stored: StoredSession = {
        id: newId(),
        taskId,
        kind,
        agentSessionId: kind === "shell" ? null : AGENTS[kind].newSessionId(),
        state: "running",
        createdAt: Date.now(),
      };
      this.#launch(stored, task, size, "start");
      this.#store.insert(stored);
      this.#changes.notify();
      return this.#withTerminal(stored);
    });
  }

  restart(id: string, size: TerminalSize): Promise<Session> {
    return this.#queue.run(async () => {
      const stored = this.#stored(id);
      if (stored.state === "running") throw new AlreadyRunningError(id);
      // The exited terminal of a session that stopped by itself stays listed until now.
      const previous = this.#live.get(id);
      this.#launch(stored, this.#task(stored.taskId), size, "resume");
      if (previous) await this.#terminals.close(previous.terminalId);
      this.#store.setState(id, "running");
      this.#changes.notify();
      return this.#withTerminal({ ...stored, state: "running" });
    });
  }

  stop(id: string): Promise<Session> {
    return this.#queue.run(async () => {
      const stored = this.#stored(id);
      await this.#halt(id);
      if (stored.state === "running") this.#settle(id);
      this.#changes.notify();
      return this.#withTerminal(this.#stored(id));
    });
  }

  remove(id: string): Promise<void> {
    return this.#queue.run(async () => {
      this.#stored(id);
      await this.#halt(id);
      this.#store.delete(id);
      this.#changes.notify();
    });
  }

  /** Closing a session's terminal stops the session; any other terminal is just closed. False when the id is unknown. */
  async closeTerminal(terminalId: string): Promise<boolean> {
    const sessionId = this.#terminals.get(terminalId)?.info.sessionId;
    if (sessionId) {
      try {
        await this.stop(sessionId);
        return true;
      } catch (error) {
        if (!(error instanceof SessionNotFoundError)) throw error;
      }
    }
    return this.#terminals.close(terminalId);
  }

  hasRunningIn(taskIds: ReadonlySet<string>): boolean {
    return this.#store
      .list()
      .some((stored) => taskIds.has(stored.taskId) && stored.state === "running");
  }

  removeAllIn(taskIds: ReadonlySet<string>): Promise<void> {
    return this.#queue.run(async () => {
      const doomed = this.#store.list().filter((stored) => taskIds.has(stored.taskId));
      for (const stored of doomed) {
        // oxlint-disable-next-line no-await-in-loop -- processes are stopped one after the other
        await this.#halt(stored.id);
        this.#store.delete(stored.id);
      }
      if (doomed.length > 0) this.#changes.notify();
    });
  }

  /**
   * Starts again every session that was running when the server last went down: a shell fresh,
   * an agent resumed. One that cannot start becomes `stopped`; nothing here may keep the server
   * from starting.
   */
  restore(): void {
    for (const stored of this.#store.list()) {
      if (stored.state !== "running") continue;
      try {
        // Starting it again would open a new conversation, which the user did not ask for.
        if (stored.kind === "codex" && stored.agentSessionId === null) {
          this.#store.setState(stored.id, "unresumable");
          continue;
        }
        this.#launch(stored, this.#task(stored.taskId), RESTORED_SIZE, "resume");
      } catch (error) {
        console.error(
          `corral-server: could not restore session ${stored.id} (${stored.kind})`,
          error,
        );
        this.#store.setState(stored.id, "stopped");
      }
    }
  }

  /** Called before the terminals are closed: what the sessions were doing is kept for the next start. */
  async shutDown(): Promise<void> {
    await this.#queue.run(async () => undefined);
    this.#shuttingDown = true;
    await Promise.all(
      [...this.#live.values()].flatMap((live) => (live.discovery ? [live.discovery.finish()] : [])),
    );
  }

  #stored(id: string): StoredSession {
    const stored = this.#store.get(id);
    if (!stored) throw new SessionNotFoundError(id);
    return stored;
  }

  #task(id: string): Task {
    const task = this.#tasks.get(id);
    if (!task) throw new TaskNotFoundError(id);
    return task;
  }

  #withTerminal(stored: StoredSession): Session {
    return { ...stored, terminalId: this.#live.get(stored.id)?.terminalId ?? null };
  }

  /** Spawns the session's process in a new terminal; throws, changing nothing, when it cannot. */
  #launch(stored: StoredSession, task: Task, size: TerminalSize, how: "start" | "resume"): void {
    const adapter = stored.kind === "shell" ? undefined : AGENTS[stored.kind];
    const input: CreateTerminalInput = {
      cwd: task.workspacePath,
      env: { CORRAL_SESSION_ID: stored.id, CORRAL_TASK_ID: stored.taskId },
      size,
    };
    if (adapter) {
      if (!isExecutable(adapter.command, process.env["PATH"]))
        throw new AgentNotFoundError(adapter.command);
      input.command = adapter.command;
      const id = stored.agentSessionId;
      const resumable =
        how === "resume" && id !== null && (adapter.hasConversation?.(id, process.env) ?? true);
      input.args = resumable ? adapter.resumeArgs(id) : adapter.startArgs(id);
    }
    const spawnedAt = Date.now();
    const info = this.#terminals.create(input, { taskId: stored.taskId, sessionId: stored.id });
    const discovery =
      stored.kind === "codex" && stored.agentSessionId === null
        ? watchForCodexSession({
            home: codexHome(process.env),
            cwd: task.workspacePath,
            since: spawnedAt,
            claimedIds: () => this.#store.agentSessionIds("codex"),
            onFound: (agentSessionId) => {
              this.#store.setAgentSessionId(stored.id, agentSessionId);
              this.#changes.notify();
            },
          })
        : undefined;
    this.#live.set(stored.id, { terminalId: info.id, discovery });
    void this.#terminals
      .get(info.id)
      ?.whenExitRecorded()
      .then(() => this.#exitedByItself(stored.id, info.id));
  }

  #exitedByItself(sessionId: string, terminalId: string): Promise<void> {
    return this.#queue.run(async () => {
      const live = this.#live.get(sessionId);
      if (this.#shuttingDown || live?.terminalId !== terminalId) return;
      await live.discovery?.finish();
      live.discovery = undefined;
      this.#settle(sessionId);
      this.#changes.notify();
    });
  }

  /** Kills the session's process, closes its terminal and ends the search for its id. */
  async #halt(id: string): Promise<void> {
    const live = this.#live.get(id);
    if (!live) return;
    await this.#terminals.close(live.terminalId);
    await live.discovery?.finish();
    this.#live.delete(id);
  }

  /** A session whose process is gone: `stopped`, unless it is a Codex session whose id was never learned. */
  #settle(id: string): void {
    const stored = this.#store.get(id);
    if (!stored) return;
    const lost = stored.kind === "codex" && stored.agentSessionId === null;
    this.#store.setState(id, lost ? "unresumable" : "stopped");
  }
}
