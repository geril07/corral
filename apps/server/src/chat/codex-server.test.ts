import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { isRecord } from "../../test/json.ts";
import { CodexServers } from "./codex-server.ts";

const agents = useFakeAgents();
const FAKE_CODEX = join(import.meta.dirname, "../../test/fake-agents/bin/codex");
const SESSION = "corral-codex-pool";

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function launcher(root: string, dataDir = join(root, "data")): Promise<CodexServers> {
  return new CodexServers({ dataDir, readyTimeoutMs: 10_000, exitGraceMs: 400 });
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling the process is the point
    if (await predicate()) return;
    // oxlint-disable-next-line no-await-in-loop -- see above
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function recordPid(dataDir: string, sessionId: string): Promise<number | undefined> {
  const text = await readFile(join(dataDir, "chat", `codex-server-${sessionId}.json`), "utf8");
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) && typeof parsed["pid"] === "number" ? parsed["pid"] : undefined;
}

test(
  "two legs of one session share one app-server, and the last release stops it",
  { timeout: 20_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "corral-codex-pool-"));
    const servers = await launcher(root);
    try {
      const launch = { sessionId: SESSION, command: FAKE_CODEX, cwd: root, env: processEnv() };
      const chat = await servers.acquire("chat:1", launch);
      const terminal = await servers.acquire("terminal:1", launch);
      expect(terminal.socketPath).toBe(chat.socketPath);
      expect(servers.clientsOf(SESSION)).toBe(2);
      const pid = await recordPid(join(root, "data"), SESSION);
      expect(pid).toBeDefined();
      // One process, not one per leg: the fake logs every app-server it was asked to start.
      const started = (await agents.launches()).filter((entry) => entry.argv[0] === "app-server");
      expect(started).toHaveLength(1);
      expect(started[0]?.argv).toContain(`unix://${chat.socketPath}`);

      await servers.release("terminal:1", SESSION);
      expect(servers.socketOf(SESSION)).toBe(chat.socketPath);
      expect(alive(pid!)).toBe(true);

      await servers.release("chat:1", SESSION);
      // No leaked server after the last stop (the red check for a stop that leaves it running).
      await until(() => !alive(pid!), "the app-server to exit");
      expect(servers.socketOf(SESSION)).toBeUndefined();
      await expect(
        readFile(join(root, "data", "chat", `codex-server-${SESSION}.json`), "utf8"),
      ).rejects.toThrow("ENOENT");
    } finally {
      await servers.closeAll();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a second pool on the same data directory stops the previous app-server before starting",
  { timeout: 20_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "corral-codex-pool-"));
    const first = await launcher(root);
    const launch = { sessionId: SESSION, command: FAKE_CODEX, cwd: root, env: processEnv() };
    try {
      await first.acquire("chat:1", launch);
      const firstPid = await recordPid(join(root, "data"), SESSION);
      expect(firstPid).toBeDefined();

      // A server that starts again (the record is what fences the second writer).
      const second = await launcher(root);
      try {
        await second.acquire("chat:1", launch);
        const secondPid = await recordPid(join(root, "data"), SESSION);
        expect(secondPid).toBeDefined();
        expect(secondPid).not.toBe(firstPid);
        await until(() => !alive(firstPid!), "the replaced app-server to exit");
      } finally {
        await second.closeAll();
      }
    } finally {
      await first.closeAll();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a crash tells the clients; an expected stop is silent", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "corral-codex-pool-"));
  const servers = await launcher(root);
  const launch = { sessionId: SESSION, command: FAKE_CODEX, cwd: root, env: processEnv() };
  const exits: string[] = [];
  try {
    await servers.acquire("chat", { ...launch, onExit: (reason) => exits.push(reason) });
    const pid = await recordPid(join(root, "data"), SESSION);
    process.kill(pid!, "SIGKILL");
    await until(() => exits.length === 1, "the crash to reach the client");
    expect(exits[0]).toContain("SIGKILL");

    // A stop the session asked for is not news: no `onExit`, so no false launch error.
    await servers.acquire("chat", { ...launch, onExit: (reason) => exits.push(reason) });
    await servers.release("chat", SESSION);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(exits).toHaveLength(1);
  } finally {
    await servers.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});
