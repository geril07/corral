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

/**
 * Waits until the fake `agent` has been launched `count` times, then returns those launches.
 * `timeoutMs` is for a test whose own budget is longer, such as a restore of several agents.
 */
export async function launchesOf(
  agents: ReturnType<typeof useFakeAgents>,
  agent: Launch["agent"],
  count: number,
  timeoutMs = 10_000,
): Promise<Launch[]> {
  await expect
    .poll(async () => (await agents.launches()).filter((launch) => launch.agent === agent).length, {
      timeout: timeoutMs,
      message: `${count} launches of ${agent}`,
    })
    .toBe(count);
  return (await agents.launches()).filter((launch) => launch.agent === agent);
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
