import type { CreateTerminalInput, TerminalInfo } from "@corral/protocol/rpc";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { ChangeFeed } from "../changes/change-feed.ts";
import { TerminalSession } from "./terminal-session.ts";

export class TerminalRegistry {
  readonly #sessions = new Map<string, TerminalSession>();
  readonly #changes = new ChangeFeed();

  list(): TerminalInfo[] {
    return [...this.#sessions.values()].map((session) => session.info);
  }

  get(id: string): TerminalSession | undefined {
    return this.#sessions.get(id);
  }

  create(input: CreateTerminalInput): TerminalInfo {
    const id = randomUUID();
    const session = new TerminalSession(
      id,
      {
        taskId: input.taskId ?? null,
        command: input.command ?? process.env["SHELL"] ?? "/bin/sh",
        args: input.args ?? [],
        cwd: input.cwd ?? homedir(),
        env: stringEnv({ ...process.env, ...input.env, TERM: "xterm-256color" }),
        size: input.size,
      },
      () => this.#changes.notify(),
    );
    this.#sessions.set(id, session);
    this.#changes.notify();
    return session.info;
  }

  /** Kills and forgets the terminal; false when the id is unknown. */
  close(id: string): boolean {
    const session = this.#sessions.get(id);
    if (!session) return false;
    this.#sessions.delete(id);
    void session.close();
    this.#changes.notify();
    return true;
  }

  /** Resolves once every process is gone. */
  async closeAll(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }

  /** Yields the list now and after every change; changes between two yields collapse into one. */
  watch(signal: AbortSignal | undefined): AsyncGenerator<TerminalInfo[]> {
    return this.#changes.watch(() => this.list(), signal);
  }

  /** Whether any of the tasks has a terminal whose process still runs. */
  hasRunningIn(taskIds: ReadonlySet<string>): boolean {
    return this.list().some(
      (info) => info.taskId !== null && taskIds.has(info.taskId) && info.exit === null,
    );
  }

  /** Kills and forgets every terminal of the tasks; resolves once the processes are gone. */
  async closeAllIn(taskIds: ReadonlySet<string>): Promise<void> {
    const doomed = [...this.#sessions.values()].filter((session) => {
      const { taskId } = session.info;
      return taskId !== null && taskIds.has(taskId);
    });
    for (const session of doomed) this.#sessions.delete(session.id);
    if (doomed.length > 0) this.#changes.notify();
    await Promise.all(doomed.map((session) => session.close()));
  }
}

function stringEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
