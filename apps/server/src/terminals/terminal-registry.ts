import type { CreateTerminalInput, TerminalInfo } from "@corral/protocol/rpc";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { TerminalSession } from "./terminal-session.ts";

export class TerminalRegistry {
  readonly #sessions = new Map<string, TerminalSession>();
  readonly #listeners = new Set<() => void>();

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
        command: input.command ?? process.env["SHELL"] ?? "/bin/sh",
        args: input.args ?? [],
        cwd: input.cwd ?? homedir(),
        env: stringEnv({ ...process.env, ...input.env, TERM: "xterm-256color" }),
        size: input.size,
      },
      () => this.#notify(),
    );
    this.#sessions.set(id, session);
    this.#notify();
    return session.info;
  }

  /** Kills and forgets the terminal; false when the id is unknown. */
  close(id: string): boolean {
    const session = this.#sessions.get(id);
    if (!session) return false;
    this.#sessions.delete(id);
    void session.close();
    this.#notify();
    return true;
  }

  /** Resolves once every process is gone. */
  async closeAll(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }

  /** Yields the list now and after every change; changes between two yields collapse into one. */
  async *watch(signal: AbortSignal | undefined): AsyncGenerator<TerminalInfo[]> {
    let changed = true;
    let wake: (() => void) | undefined;
    const listener = () => {
      changed = true;
      wake?.();
    };
    this.#listeners.add(listener);
    const aborted = () => wake?.();
    signal?.addEventListener("abort", aborted);
    try {
      // oxlint-disable-next-line no-unmodified-loop-condition -- `aborted` flips from the abort listener
      while (!signal?.aborted) {
        if (changed) {
          changed = false;
          yield this.list();
        } else {
          // oxlint-disable-next-line no-await-in-loop -- one wait per change is the point
          await new Promise<void>((resolve) => (wake = resolve));
          wake = undefined;
        }
      }
    } finally {
      this.#listeners.delete(listener);
      signal?.removeEventListener("abort", aborted);
    }
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

function stringEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
