import { normalizeLabel } from "@corral/protocol/label";
import type { AgentStatus, CreateTerminalInput, TerminalInfo } from "@corral/protocol/rpc";
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

  /**
   * `owner` is the task and session the terminal runs for; a loose terminal has none.
   * `onStatus` hears what the program reports about itself over OSC 7501.
   */
  create(
    input: CreateTerminalInput,
    owner: { taskId: string; sessionId: string } | null = null,
    onStatus?: (status: AgentStatus | null) => void,
  ): TerminalInfo {
    const id = randomUUID();
    const session = new TerminalSession(
      id,
      {
        taskId: owner?.taskId ?? null,
        sessionId: owner?.sessionId ?? null,
        command: input.command ?? process.env["SHELL"] ?? "/bin/sh",
        args: input.args ?? [],
        cwd: input.cwd ?? homedir(),
        env: stringEnv({ ...process.env, ...input.env, TERM: "xterm-256color" }),
        size: input.size,
      },
      { onChange: () => this.#changes.notify(), ...(onStatus ? { onStatus } : {}) },
    );
    this.#sessions.set(id, session);
    this.#changes.notify();
    return session.info;
  }

  /**
   * Names the terminal for the user; a blank label takes the name away again. The process is
   * untouched. Undefined when the id is unknown; a terminal in a task is named through its session.
   */
  setLabel(id: string, label: string | null): TerminalInfo | undefined {
    const session = this.#sessions.get(id);
    if (!session) return undefined;
    session.setLabel(normalizeLabel(label));
    return session.info;
  }

  /** Forgets the terminal at once and resolves, once its process is gone, with whether the id was known. */
  async close(id: string): Promise<boolean> {
    const session = this.#sessions.get(id);
    if (!session) return false;
    this.#sessions.delete(id);
    this.#changes.notify();
    await session.close();
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
}

function stringEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
