import { Session, type AgentStatus } from "@corral/protocol/rpc";
import { expect } from "vite-plus/test";
import { z } from "zod";
import type { Launch, useFakeAgents } from "./fake-agents.ts";
import { within, type useServer } from "./server-fixture.ts";

type Api = Awaited<ReturnType<ReturnType<typeof useServer>["rpc"]>>;

/** The sessions as `sessions.watch` first reports them. */
export async function sessionsOf(api: Api): Promise<Session[]> {
  const updates = await api.sessions.watch();
  const first = await within(updates.next(), "the sessions");
  await updates.return?.();
  return z.array(Session).parse(first.value);
}

/** An agent's own server (`opencode serve`, `codex app-server`) is not a frontend launch. */
function isFrontend(launch: Launch): boolean {
  return launch.argv[0] !== "serve" && launch.argv[0] !== "app-server";
}

/**
 * Waits until the fake `agent` has been launched `count` times, then returns those launches.
 * `timeoutMs` is for a test whose own budget is longer, such as a restore of several agents.
 * An agent's own server is not counted: it is infrastructure, one per run or per session.
 */
export async function launchesOf(
  agents: ReturnType<typeof useFakeAgents>,
  agent: Launch["agent"],
  count: number,
  timeoutMs = 10_000,
): Promise<Launch[]> {
  const frontends = async () =>
    (await agents.launches()).filter((launch) => launch.agent === agent && isFrontend(launch));
  await expect
    .poll(async () => (await frontends()).length, {
      timeout: timeoutMs,
      message: `${count} launches of ${agent}`,
    })
    .toBe(count);
  return frontends();
}

/**
 * The argv of a terminal frontend without C3's Codex app-server prefix (`--remote unix://…`).
 * The prefix is the session's app-server, which both legs share; tests about the agent's own
 * flags assert what is left.
 */
export function frontendArgs(argv: readonly string[]): string[] {
  return argv[0] === "--remote" && argv[1]?.startsWith("unix://") ? argv.slice(2) : [...argv];
}

/**
 * Waits until the fake `agent`'s TUI has been launched `count` times. An agent that keeps its
 * session in a shared server (`opencode serve`, C1) is launched twice per start — the server and
 * the TUI — so a test about the frontend counts only the launches that are not `serve`.
 */
export async function tuiLaunchesOf(
  agents: ReturnType<typeof useFakeAgents>,
  agent: Launch["agent"],
  count: number,
  timeoutMs = 10_000,
): Promise<Launch[]> {
  const tuis = async () =>
    (await agents.launches()).filter((launch) => launch.agent === agent && isFrontend(launch));
  await expect
    .poll(async () => (await tuis()).length, {
      timeout: timeoutMs,
      message: `${count} TUI launches of ${agent}`,
    })
    .toBe(count);
  return tuis();
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Follows `sessions.watch` for one session and keeps what its status was after each update. */
export async function watchStatus(api: Api, sessionId: string) {
  const updates = await api.sessions.watch();
  const history: (AgentStatus | null)[] = [];
  const listeners = new Set<() => void>();
  let cursor = 0;
  const done = (async () => {
    for await (const sessions of updates) {
      const session = z
        .array(Session)
        .parse(sessions)
        .find((candidate) => candidate.id === sessionId);
      if (session) history.push(session.status);
      for (const listener of listeners) listener();
    }
    // The connection closing under the watch (the test is over) ends it, not an error.
  })().catch(() => undefined);

  return {
    /** Each status the session had, oldest first; an update that changed something else is not a new status. */
    get statuses() {
      return history.filter(
        (status, index) => index === 0 || !sameStatus(status, history[index - 1]),
      );
    },
    /**
     * Resolves with the first status that satisfies `predicate` among those not yet waited past,
     * now or later, so consecutive calls follow the sequence of statuses.
     */
    until(predicate: (status: AgentStatus | null) => boolean, description: string) {
      return within(
        new Promise<AgentStatus | null>((resolve) => {
          const check = () => {
            const index = history.findIndex((status, i) => i >= cursor && predicate(status));
            if (index < 0) return;
            cursor = index + 1;
            listeners.delete(check);
            resolve(history[index]!);
          };
          listeners.add(check);
          check();
        }),
        description,
      );
    },
    async stop() {
      await updates.return?.();
      await done;
    },
  };
}

function sameStatus(a: AgentStatus | null | undefined, b: AgentStatus | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.state === b.state && a.kind === b.kind && a.message === b.message;
}
