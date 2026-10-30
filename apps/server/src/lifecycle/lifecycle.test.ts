import { capabilityProtocols, PROTOCOL_VERSION, protocolUrl } from "@corral/protocol/handshake";
import {
  endpointFilePath,
  ServerEndpoint,
  SERVER_LOCK_REFUSED_EXIT_CODE,
} from "@corral/protocol/server-endpoint";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { WebSocket as WsWebSocket } from "ws";
import { lockFilePath } from "./lock.ts";
import { identityOf, sameFile } from "./owned-file.ts";

const MAIN = path.join(import.meta.dirname, "../main.ts");
const DEADLINE_MS = 15_000;
const SERVER_TEST_TIMEOUT_MS = DEADLINE_MS + 5_000;

interface Launched {
  readonly proc: ChildProcess;
  readonly pid: number;
  /** Resolves with the URL from the readiness line, or `null` when the process exits first. */
  readonly listening: Promise<string | null>;
  readonly exited: Promise<{ code: number | null; stderr: string }>;
  /** Everything the process wrote so far, for asserting a secret never reaches it. */
  output(): string;
}

let stateDir: string;
let spawned: ChildProcess[] = [];

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "corral-lifecycle-"));
});

afterEach(async () => {
  const running = spawned.filter((proc) => proc.exitCode === null && proc.signalCode === null);
  spawned = [];
  await Promise.all(
    running.map((proc) => {
      const gone = new Promise((resolve) => proc.once("exit", resolve));
      proc.kill("SIGKILL");
      return gone;
    }),
  );
  rmSync(stateDir, { recursive: true, force: true });
});

function launch(): Launched {
  const proc = spawn(process.execPath, [MAIN], {
    env: {
      ...process.env,
      CORRAL_STATE_DIR: stateDir,
      CORRAL_DATA_DIR: path.join(stateDir, "data"),
      CORRAL_CONFIG_DIR: path.join(stateDir, "config"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(proc);
  let stdout = "";
  let stderr = "";
  proc.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) =>
    proc.once("exit", (code) => resolve({ code, stderr })),
  );
  const listening = new Promise<string | null>((resolve) => {
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = /corral-server listening (\S+)/.exec(stdout);
      if (match) resolve(match[1] ?? null);
    });
    void exited.then(() => resolve(null));
  });
  return { proc, pid: proc.pid!, listening, exited, output: () => stdout + stderr };
}

function within<T>(promise: Promise<T>, what: string): Promise<T> {
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), DEADLINE_MS).unref(),
  );
  return Promise.race([promise, deadline]);
}

async function start(): Promise<Launched & { url: string }> {
  const server = launch();
  const url = await within(server.listening, "the readiness line");
  if (url === null) throw new Error(`server exited: ${(await server.exited).stderr}`);
  return { ...server, url };
}

function readEndpoint(): ServerEndpoint {
  return ServerEndpoint.parse(JSON.parse(readFileSync(endpointFilePath(stateDir), "utf8")));
}

function capabilityOf(endpoint = readEndpoint()): string {
  if (endpoint.capability === undefined) throw new Error("endpoint has no capability");
  return endpoint.capability;
}

function stop(server: Launched, signal: NodeJS.Signals) {
  server.proc.kill(signal);
  return within(server.exited, "the server to exit");
}

async function deadPid(): Promise<number> {
  const proc = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => proc.once("exit", resolve));
  return proc.pid!;
}

function writeLock(content: string) {
  writeFileSync(lockFilePath(stateDir), content);
}

describe("endpoint file", () => {
  test("describes the running server, which accepts our protocol version", async () => {
    const server = await start();

    expect(readEndpoint()).toEqual({
      pid: server.pid,
      url: server.url,
      capability: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      protocolVersion: PROTOCOL_VERSION,
      startedAt: expect.any(Number),
    });
    const endpoint = readEndpoint();
    const socket = new WebSocket(
      protocolUrl(endpoint.url, "/rpc"),
      capabilityProtocols(capabilityOf(endpoint)),
    );
    await within(new Promise((resolve) => socket.addEventListener("open", resolve)), "open");
    socket.close();
  });

  test("is readable only by its owner and the capability is never written to the log or argv", async () => {
    chmodSync(stateDir, 0o755);
    const server = await start();
    const endpoint = readEndpoint();

    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(endpointFilePath(stateDir)).mode & 0o777).toBe(0o600);
    expect(server.output()).not.toContain(endpoint.capability);
    const argv = execFileSync("ps", ["-o", "args=", "-p", String(server.pid)], {
      encoding: "utf8",
    });
    expect(argv).not.toContain(endpoint.capability);
  });

  test("replacing an endpoint left with looser permissions makes the new file owner-only", async () => {
    const target = endpointFilePath(stateDir);
    writeFileSync(
      target,
      JSON.stringify({
        pid: 1,
        url: "ws://127.0.0.1:1",
        protocolVersion: 1,
        startedAt: 0,
      }),
    );
    chmodSync(target, 0o644);
    const before = statSync(target);

    const server = await start();
    const after = statSync(target);

    expect(after.mode & 0o777).toBe(0o600);
    expect(after.ino).not.toBe(before.ino);
    expect(readEndpoint().pid).toBe(server.pid);
  });

  test("a restarted server rotates the capability, and the old one is refused", async () => {
    const first = await start();
    const oldCapability = capabilityOf();
    await stop(first, "SIGTERM");

    await start();
    const newCapability = capabilityOf();
    expect(newCapability).not.toBe(oldCapability);

    const socket = new WsWebSocket(
      protocolUrl(readEndpoint().url, "/rpc"),
      capabilityProtocols(oldCapability),
    );
    const error = await within(
      new Promise<string>((resolve) => socket.once("error", (event) => resolve(event.message))),
      "the old capability to be refused",
    );
    expect(error).toContain("401");
    expect(readEndpoint().capability).toBe(newCapability);
  });
});

describe("single instance", () => {
  test(
    "a second server refuses and leaves the first one's files and process alone",
    async () => {
      const first = await start();
      const files = [lockFilePath(stateDir), endpointFilePath(stateDir)];
      const before = files.map((file) => ({
        identity: identityOf(file),
        text: readFileSync(file, "utf8"),
      }));

      const second = launch();
      const result = await within(second.exited, "the second server to exit");

      expect(result.code).toBe(SERVER_LOCK_REFUSED_EXIT_CODE);
      expect(result.stderr).toContain(`pid ${first.pid}`);
      files.forEach((file, index) => {
        expect(sameFile(identityOf(file), before[index]!.identity)).toBe(true);
        expect(readFileSync(file, "utf8")).toBe(before[index]!.text);
      });
      expect(first.proc.exitCode).toBeNull();
    },
    SERVER_TEST_TIMEOUT_MS,
  );

  test("a lock with a live pid and a recent start is refused untouched", async () => {
    const text = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
    writeLock(text);

    const result = await within(launch().exited, "the server to exit");

    expect(result.code).toBe(SERVER_LOCK_REFUSED_EXIT_CODE);
    expect(readFileSync(lockFilePath(stateDir), "utf8")).toBe(text);
  });

  test("a lock that cannot be read is never treated as dead", async () => {
    writeLock("{ not json");

    const result = await within(launch().exited, "the server to exit");

    expect(result.code).toBe(SERVER_LOCK_REFUSED_EXIT_CODE);
    expect(readFileSync(lockFilePath(stateDir), "utf8")).toBe("{ not json");
  });

  test("a lock left by a crashed server is recovered", async () => {
    writeLock(JSON.stringify({ pid: await deadPid(), startedAt: Date.now() }));

    const server = await start();

    expect(JSON.parse(readFileSync(lockFilePath(stateDir), "utf8")).pid).toBe(server.pid);
    expect(readEndpoint().pid).toBe(server.pid);
  });

  test("a live pid in a lock older than the last boot is a reused pid, so the lock is recovered", async () => {
    writeLock(JSON.stringify({ pid: process.pid, startedAt: 0 }));

    const server = await start();

    expect(JSON.parse(readFileSync(lockFilePath(stateDir), "utf8")).pid).toBe(server.pid);
  });

  describe.each([
    ["no lock", async () => {}],
    [
      "a stale lock",
      async () => writeLock(JSON.stringify({ pid: await deadPid(), startedAt: Date.now() })),
    ],
  ])("starting at the same moment over %s", (_name, prepare) => {
    // Repeated because the interleavings differ from run to run.
    test.for([1, 2, 3, 4, 5])(
      "round %i: exactly one server survives and owns the lock and the endpoint",
      async () => {
        await prepare();

        const racers = Array.from({ length: 6 }, launch);
        await within(
          Promise.all(racers.map((racer) => Promise.race([racer.listening, racer.exited]))),
          "all racers to settle",
        );

        // Two starters can both replace a dead lock; the one whose file got overwritten
        // (exit 1, within the server's lock check interval) stands down.
        const holder = JSON.parse(readFileSync(lockFilePath(stateDir), "utf8")).pid;
        const survivor = racers.find((racer) => racer.pid === holder)!;
        const others = racers.filter((racer) => racer !== survivor);
        const codes = await within(
          Promise.all(others.map(async (racer) => (await racer.exited).code)),
          "the other racers to exit",
        );
        expect(codes.every((code) => code === SERVER_LOCK_REFUSED_EXIT_CODE || code === 1)).toBe(
          true,
        );
        expect(survivor.proc.exitCode).toBeNull();
        expect(readEndpoint().pid).toBe(survivor.pid);
      },
    );
  });
});

describe("shutdown", () => {
  test.each(["SIGTERM", "SIGINT"] as const)(
    "%s removes the lock and the endpoint file",
    async (signal) => {
      const server = await start();

      const result = await stop(server, signal);

      expect(result.code).toBe(0);
      expect(() => readFileSync(lockFilePath(stateDir))).toThrow(/ENOENT/);
      expect(() => readFileSync(endpointFilePath(stateDir))).toThrow(/ENOENT/);
    },
  );

  test("a stopped server's state dir can be started again", async () => {
    await stop(await start(), "SIGTERM");

    const next = await start();

    expect(readEndpoint().pid).toBe(next.pid);
  });

  test("files that another process put in place are left alone", async () => {
    const server = await start();
    const foreign = path.join(stateDir, "foreign");
    for (const target of [lockFilePath(stateDir), endpointFilePath(stateDir)]) {
      writeFileSync(foreign, `foreign ${path.basename(target)}`);
      renameSync(foreign, target);
    }

    await stop(server, "SIGTERM");

    expect(readFileSync(lockFilePath(stateDir), "utf8")).toBe("foreign server.lock");
    expect(readFileSync(endpointFilePath(stateDir), "utf8")).toBe("foreign endpoint.json");
  });
});
