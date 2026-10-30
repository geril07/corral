import { Session } from "@corral/protocol/rpc";
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

/** Waits until the fake `agent` has been launched `count` times, then returns those launches. */
export async function launchesOf(
  agents: ReturnType<typeof useFakeAgents>,
  agent: Launch["agent"],
  count: number,
): Promise<Launch[]> {
  await expect
    .poll(async () => (await agents.launches()).filter((launch) => launch.agent === agent).length, {
      timeout: 10_000,
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
