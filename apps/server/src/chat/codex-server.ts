import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { codexServerArgs } from "../agents/codex.ts";
import { messageOf } from "./chat-errors.ts";
import {
  recordWriter,
  releasePreviousWriter,
  releaseWriterIf,
  writerPath,
} from "./writer-claim.ts";

/** Where one session's `codex app-server` listens; both of the session's frontends use it. */
export interface CodexServerAddress {
  socketPath: string;
}

/** What starting a Codex session's app-server needs. */
export interface CodexServerLaunch {
  /** The session whose conversation this server owns; one server per session (C3, decision b). */
  sessionId: string;
  /** The `codex` executable; the same one the session's frontends run. */
  command: string;
  cwd: string;
  env: Record<string, string>;
  /** Called once when the server exits for any reason, with a sentence for the user. */
  onExit?: (reason: string) => void;
}

export interface CodexServersOptions {
  /** Inside the server's data directory: sockets in `<dataDir>/codex/`, records in `<dataDir>/chat/`. */
  dataDir: string;
  /** How long the app-server gets to create its socket. */
  readyTimeoutMs?: number;
  /** How long it gets between SIGTERM and SIGKILL of its process group. */
  exitGraceMs?: number;
  /** Test seam: `/proc` identity of a recorded pid; production reads it. */
  identityOfPid?: (pid: number) => string | null;
}

const READY_TIMEOUT_MS = 15_000;
const EXIT_GRACE_MS = 3000;
const POLL_MS = 25;

interface RunningServer {
  child: ChildProcess;
  socketPath: string;
  /** Resolves when the process is gone; never rejects. */
  exited: Promise<void>;
  /**
   * Set before an intentional stop. An expected exit is cleanup, not news: a session stopping its
   * own server must not be told it crashed (a false `launchError`), and a terminal must not be
   * closed for a stop the session asked for.
   */
  expectedStop: boolean;
}

/**
 * The Codex app-servers of one Corral run, **one per session** (C3 decision b). A session's two
 * frontends — the chat driver over the socket and the terminal with `--remote unix://…` — are
 * clients of the same process, which is what the probe measured as `both-live`; the process is
 * the session's writer, so a second app-server cannot hold its thread (`thread … already has an
 * active writer`, measured).
 *
 * The record is per session, `<dataDir>/chat/codex-server-<session>.json`, written through
 * `writer-claim.ts` with the pid and its `/proc` start time: a Corral that starts again stops the
 * previous app-server before spawning its own, and a reused pid is left alone. The last attached
 * leg stops the server (SIGTERM to the group, then SIGKILL after the grace); a session that never
 * stops the server cannot leak it across restarts, because the record outlives the process.
 */
export class CodexServers {
  readonly #socketDir: string;
  readonly #chatDir: string;
  readonly #readyTimeoutMs: number;
  readonly #exitGraceMs: number;
  readonly #identityOfPid: ((pid: number) => string | null) | undefined;
  readonly #servers = new Map<string, RunningServer>();
  readonly #owners = new Map<string, Set<string>>();
  readonly #exits = new Map<string, Set<(reason: string) => void>>();
  readonly #starting = new Map<string, Promise<RunningServer>>();
  readonly #stopping = new Map<string, Promise<void>>();

  constructor(options: CodexServersOptions) {
    this.#socketDir = `${options.dataDir}/codex`;
    this.#chatDir = `${options.dataDir}/chat`;
    this.#readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.#exitGraceMs = options.exitGraceMs ?? EXIT_GRACE_MS;
    this.#identityOfPid = options.identityOfPid;
  }

  /** The socket of the session's live server, or undefined when none runs and none is starting. */
  socketOf(sessionId: string): string | undefined {
    return this.#servers.get(sessionId)?.socketPath;
  }

  /** How many legs (chat drivers and terminals) currently hold the session's server. */
  clientsOf(sessionId: string): number {
    return this.#owners.get(sessionId)?.size ?? 0;
  }

  /**
   * Registers one client of the session's server and returns its socket, starting the server if
   * this is the first one. Releasing an unknown owner is a no-op, so a stop that races an exit
   * cannot kill a server another leg still uses.
   */
  async acquire(owner: string, launch: CodexServerLaunch): Promise<CodexServerAddress> {
    const running = await this.#ensure(launch);
    if (this.#servers.get(launch.sessionId) === running) {
      const owners = this.#owners.get(launch.sessionId) ?? new Set<string>();
      owners.add(owner);
      this.#owners.set(launch.sessionId, owners);
      if (launch.onExit !== undefined) {
        const exits = this.#exits.get(launch.sessionId) ?? new Set<(reason: string) => void>();
        exits.add(launch.onExit);
        this.#exits.set(launch.sessionId, exits);
      }
    }
    return { socketPath: running.socketPath };
  }

  /** Lets one client go; the last one stops the session's server. Resolves once it is gone. */
  async release(owner: string, sessionId: string): Promise<void> {
    const owners = this.#owners.get(sessionId);
    const owned = owners?.delete(owner) ?? false;
    if (owners !== undefined && owners.size === 0) this.#owners.delete(sessionId);
    if (owned && (this.#owners.get(sessionId)?.size ?? 0) === 0) {
      await this.#stop(sessionId);
      return;
    }
    // A release that arrives after another leg already started the stop waits for it too, so
    // "the release resolved" means nothing of this server is left running.
    await this.#stopping.get(sessionId);
  }

  /** Stops every server whatever its clients say; the server is shutting down. */
  async closeAll(): Promise<void> {
    this.#owners.clear();
    // A start in flight would otherwise spawn after this sweep and outlive it.
    await Promise.allSettled(this.#starting.values());
    await Promise.all([...this.#servers.keys()].map((sessionId) => this.#stop(sessionId)));
  }

  #ensure(launch: CodexServerLaunch): Promise<RunningServer> {
    const { sessionId } = launch;
    const starting = this.#starting.get(sessionId);
    if (starting !== undefined) return starting;
    const stopping = this.#stopping.get(sessionId);
    const begin = async (): Promise<RunningServer> => {
      // A stop in flight must finish before anything joins the server it is stopping: the old
      // socket still answers for a moment after SIGTERM, and a client that took it would lose
      // the conversation when the process goes.
      if (stopping !== undefined) await stopping;
      const running = this.#servers.get(sessionId);
      if (running !== undefined) return running;
      return this.#start(launch);
    };
    const promise = begin().finally(() => {
      if (this.#starting.get(sessionId) === promise) this.#starting.delete(sessionId);
    });
    this.#starting.set(sessionId, promise);
    return promise;
  }

  async #start(launch: CodexServerLaunch): Promise<RunningServer> {
    const { sessionId } = launch;
    // The listener is authored by its file permissions (the protocol has no auth); keep the
    // directory Corral owns private, for the symlink the real server puts there. `mkdirSync`'s
    // mode applies only to a new directory, so an existing one is tightened as well.
    mkdirSync(this.#socketDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.#socketDir, 0o700);
    } catch {
      // A directory this process does not own is not ours to change; the launch proceeds.
    }
    const socketPath = `${this.#socketDir}/${safeName(sessionId)}.sock`;
    const recordPath = this.#recordPath(sessionId);
    // A server a previous Corral run left behind holds the same session; the record is what stops
    // it before this one starts. A live server of this run has no record of its own to release.
    await releasePreviousWriter(
      recordPath,
      this.#identityOfPid === undefined ? {} : { identityOfPid: this.#identityOfPid },
    );
    // The previous listener's path is dead once its process is gone; a file there would make the
    // new server fail to bind, and a symlink into /tmp must not be reused.
    rmSync(socketPath, { force: true });
    let child: ChildProcess;
    try {
      child = spawn(launch.command, codexServerArgs(socketPath), {
        cwd: launch.cwd,
        env: launch.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      throw new Error(`could not start ${launch.command} app-server: ${messageOf(error)}`, {
        cause: error,
      });
    }
    let exitedResolve: () => void = noop;
    const exited = new Promise<void>((resolve) => (exitedResolve = resolve));
    const running: RunningServer = { child, socketPath, exited, expectedStop: false };
    // Diagnostics only; never logged, and drained so the child cannot block on a full pipe.
    child.stderr?.resume();
    child.stdout?.resume();
    child.once("exit", (code, signal) => {
      exitedResolve();
      this.#onServerGone(running, `the codex app-server ${exitReason(code, signal)}`);
    });
    const failure = await waitForSocket(socketPath, child, this.#readyTimeoutMs);
    if (failure !== undefined) {
      // A start that never listened must not leave a process (or its socket) behind.
      await stopProcess(child, 0);
      rmSync(socketPath, { force: true });
      throw new Error(`the codex app-server did not listen on ${socketPath}: ${failure}`);
    }
    if (child.pid !== undefined) recordWriter(recordPath, child.pid);
    this.#servers.set(sessionId, running);
    return running;
  }

  /** The server died or was stopped: its clients learn why, and a later acquire starts a new one. */
  #onServerGone(running: RunningServer, reason: string): void {
    let sessionId: string | undefined;
    for (const [each, server] of this.#servers) if (server === running) sessionId = each;
    if (sessionId === undefined) return;
    this.#servers.delete(sessionId);
    // Only this child's own record: a record naming another process is that process's fence.
    releaseWriterIf(this.#recordPath(sessionId), running.child.pid);
    rmSync(running.socketPath, { force: true });
    this.#owners.delete(sessionId);
    const exits = [...(this.#exits.get(sessionId) ?? [])];
    this.#exits.delete(sessionId);
    if (running.expectedStop) return;
    for (const onExit of exits) {
      try {
        onExit(reason);
      } catch {
        // A client that throws here must not keep the others from learning.
      }
    }
  }

  #stop(sessionId: string): Promise<void> {
    const existing = this.#stopping.get(sessionId);
    if (existing !== undefined) return existing;
    const running = this.#servers.get(sessionId);
    if (running === undefined) return Promise.resolve();
    const stopping = (async () => {
      // Before the signal: the exit handler runs while this stop is in progress.
      running.expectedStop = true;
      await stopProcess(running.child, this.#exitGraceMs);
      await running.exited;
      this.#onServerGone(running, "the codex app-server stopped");
    })().finally(() => {
      if (this.#stopping.get(sessionId) === stopping) this.#stopping.delete(sessionId);
    });
    this.#stopping.set(sessionId, stopping);
    return stopping;
  }

  #recordPath(sessionId: string): string {
    return writerPath(this.#chatDir, `codex-server-${safeName(sessionId)}`);
  }
}

/** A session id is a uuid; anything else is reduced to a name a filesystem and a URL both accept. */
function safeName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Waits until the app-server has created its socket. A Unix listener binds the path when it is
 * ready, and the real 0.166.0 server creates a symlink into its own runtime directory, so the
 * check is `stat` (which follows the link), not a successful `connect`.
 */
async function waitForSocket(
  socketPath: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      return `it ${exitReason(child.exitCode, child.signalCode)} before it listened`;
    // oxlint-disable-next-line no-await-in-loop -- polling for the socket is the point
    if (await pathExists(socketPath)) return undefined;
    // oxlint-disable-next-line no-await-in-loop -- see above
    await delay(POLL_MS);
  }
  return `it did not create the socket within ${timeoutMs} ms`;
}

async function pathExists(path: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM its process group, wait to the deadline, then SIGKILL; never throws for a gone child. */
async function stopProcess(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid === undefined) return;
  signalGroup(pid, "SIGTERM");
  const gone = await waitGone(child, graceMs);
  if (gone) return;
  signalGroup(pid, "SIGKILL");
  await waitGone(child, 1000);
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
      return;
    }
  } catch {
    // No group (or it is gone); the process itself is the fallback.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

async function waitGone(child: ChildProcess, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    // oxlint-disable-next-line no-await-in-loop -- polling a process that is going away is the point
    await delay(POLL_MS);
  }
  return child.exitCode !== null || child.signalCode !== null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)).unref());
}

function noop(): void {}

function exitReason(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) return `was killed by ${signal}`;
  return `exited with code ${code ?? "unknown"}`;
}
