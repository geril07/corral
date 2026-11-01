import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { isRecord } from "../../test/json.ts";
import { OpenCodeServers } from "./opencode-server.ts";
import { writerPath } from "./writer-claim.ts";

const agents = useFakeAgents();
const command = join(import.meta.dirname, "../..", "test", "fake-agents", "bin", "opencode");

function env(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function journal(): Promise<Record<string, unknown>[]> {
  const text = await readFile(agents.openCodeLog, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as unknown)
    .filter(isRecord);
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling the fake server's journal is the point
    if (await predicate()) return;
    // oxlint-disable-next-line no-await-in-loop -- see above
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function alive(url: string, password: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/session`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}

test("one server serves every client of the run, and the last release stops it", async () => {
  const root = await mkdtemp(join(tmpdir(), "corral-opencode-pool-"));
  const servers = new OpenCodeServers({ dataDir: root, readyTimeoutMs: 10_000, exitGraceMs: 300 });
  try {
    const first = await servers.acquire("chat:a", { command, cwd: root, env: env() });
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(first.password).not.toBe("");
    // Process-keyed, not session-keyed: one record for the server, written by the pool.
    const raw: unknown = JSON.parse(
      await readFile(writerPath(join(root, "chat"), "opencode-server"), "utf8"),
    );
    expect(isRecord(raw)).toBe(true);
    if (!isRecord(raw)) throw new Error("the writer record is not an object");
    expect(raw["pid"]).toBeGreaterThan(0);
    expect(raw["identity"]).toEqual(expect.any(String));

    const second = await servers.acquire("tui:a", { command, cwd: root, env: env() });
    expect(second).toEqual(first);
    expect(servers.clients).toBe(2);
    // One process, whatever the number of sessions or legs.
    const launches = (await agents.launches()).filter((launch) => launch.argv[0] === "serve");
    expect(launches).toHaveLength(1);

    await servers.release("chat:a");
    expect(await alive(first.url, first.password)).toBe(true);
    expect((await journal()).some((entry) => entry["action"] === "exit")).toBe(false);

    await servers.release("tui:a");
    await until(
      async () => (await journal()).some((entry) => entry["action"] === "exit"),
      "the server to stop with its last client",
    );
    expect(await alive(first.url, first.password)).toBe(false);
    await expect(
      readFile(writerPath(join(root, "chat"), "opencode-server"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
  } finally {
    await servers.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("a server that dies tells every client why, and the next acquire starts a fresh one", async () => {
  const root = await mkdtemp(join(tmpdir(), "corral-opencode-pool-"));
  const servers = new OpenCodeServers({ dataDir: root, readyTimeoutMs: 10_000, exitGraceMs: 300 });
  try {
    const exits: string[] = [];
    const first = await servers.acquire("chat:a", {
      command,
      cwd: root,
      env: env(),
      onExit: (reason) => exits.push(reason),
    });
    await servers.acquire("chat:b", {
      command,
      cwd: root,
      env: env(),
      onExit: (reason) => exits.push(reason),
    });
    const pid = (await journal()).find((entry) => entry["action"] === "listen")?.["pid"];
    expect(typeof pid).toBe("number");
    if (typeof pid !== "number") throw new Error("the fake server did not journal its pid");
    process.kill(pid, "SIGKILL");

    await until(() => exits.length === 2, "both clients to learn the server exited");
    expect(exits.every((reason) => reason.includes("opencode server"))).toBe(true);
    expect(await alive(first.url, first.password)).toBe(false);

    const again = await servers.acquire("chat:c", { command, cwd: root, env: env() });
    expect(again.url).not.toBe(first.url);
    const listens = (await journal()).filter((entry) => entry["action"] === "listen");
    expect(listens).toHaveLength(2);
  } finally {
    await servers.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("an acquire that races a stop waits for it and starts a new server", async () => {
  const root = await mkdtemp(join(tmpdir(), "corral-opencode-pool-"));
  const servers = new OpenCodeServers({ dataDir: root, readyTimeoutMs: 10_000, exitGraceMs: 300 });
  try {
    const first = await servers.acquire("chat:a", { command, cwd: root, env: env() });
    const stopping = servers.release("chat:a");
    // Same tick: the next session acquires while the old server is still shutting down.
    const second = await servers.acquire("chat:b", { command, cwd: root, env: env() });
    expect(second.url).not.toBe(first.url);
    await stopping;
    expect(await alive(first.url, first.password)).toBe(false);
    expect(await alive(second.url, second.password)).toBe(true);
    const listens = (await journal()).filter((entry) => entry["action"] === "listen");
    expect(listens).toHaveLength(2);
  } finally {
    await servers.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});
