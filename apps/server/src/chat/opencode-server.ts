import { spawn, type ChildProcess } from "node:child_process";
import { messageOf } from "./chat-errors.ts";
import { recordWriter, releasePreviousWriter, releaseWriter, writerPath } from "./writer-claim.ts";

/** Where one `opencode serve` of this Corral run listens, and the password its clients must present. */
export interface OpenCodeServerAddress {
  url: string;
  password: string;
}

/** What starting a client of the server needs; every leg of a session's launch supplies its own. */
export interface OpenCodeServerLaunch {
  /** The `opencode` executable the server runs; the same one the session's clients run. */
  command: string;
  cwd: string;
  env: Record<string, string>;
  /** Called once when the server exits for any reason, with a sentence for the user. */
  onExit?: (reason: string) => void;
}

export interface OpenCodeServersOptions {
  /** Inside the server's data directory; the process record lives in `<dataDir>/chat/`. */
  dataDir: string;
  /** How long the server gets to print its listening line. */
  readyTimeoutMs?: number;
  /** How long it gets between SIGTERM and SIGKILL of its process group. */
  exitGraceMs?: number;
  /** Test seam: `/proc` identity of a recorded pid; production reads it. */
  identityOfPid?: (pid: number) => string | null;
}

const READY_TIMEOUT_MS = 20_000;
const EXIT_GRACE_MS = 3000;
/** The record of the one shared server of this Corral run; process-keyed, not per session. */
const RECORD_NAME = "opencode-server";

interface RunningServer {
  child: ChildProcess;
  address: OpenCodeServerAddress;
  /** Resolves when the process is gone; never rejects. */
  exited: Promise<void>;
}

interface Attachment {
  onExit?: (reason: string) => void;
}

/**
 * The one `opencode serve` of a Corral run: started by the first session that needs it, stopped
 * when the last one lets go. Both of a session's legs are clients of it — the chat driver over
 * HTTP/SSE and the terminal with `--server <url>` — so the pair of frontends is live at once
 * (`design.md`, **Terminal and chat**).
 *
 * The process record is keyed by the process, not by a session: `<dataDir>/chat/opencode-server.json`
 * names the pid and its start time, so a Corral that starts again stops the previous server before
 * it spawns its own, and a second server on one data directory is refused rather than raced. The
 * module that writes it is `writer-claim.ts`, as for every writer.
 */
export class OpenCodeServers {
  readonly #recordPath: string;
  readonly #readyTimeoutMs: number;
  readonly #exitGraceMs: number;
  readonly #identityOfPid: ((pid: number) => string | null) | undefined;
  readonly #owners = new Map<string, Attachment>();
  #running: RunningServer | undefined;
  #starting: Promise<RunningServer> | undefined;
  #stopping: Promise<void> | undefined;

  constructor(options: OpenCodeServersOptions) {
    this.#recordPath = writerPath(`${options.dataDir}/chat`, RECORD_NAME);
    this.#readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.#exitGraceMs = options.exitGraceMs ?? EXIT_GRACE_MS;
    this.#identityOfPid = options.identityOfPid;
  }

  /** The address of the live server, or undefined when none runs and none is starting. */
  get address(): OpenCodeServerAddress | undefined {
    return this.#running?.address;
  }

  /** How many legs (chat drivers and terminals) currently hold the server. */
  get clients(): number {
    return this.#owners.size;
  }

  /**
   * Registers one client and returns the address, starting the server if this is the first one.
   * A client that never releases keeps the server alive; releasing an unknown owner is a no-op
   * so a stop that races an exit cannot kill a server another leg still uses.
   */
  async acquire(owner: string, launch: OpenCodeServerLaunch): Promise<OpenCodeServerAddress> {
    const running = await this.#ensure(launch);
    if (this.#running === running) {
      this.#owners.set(owner, launch.onExit === undefined ? {} : { onExit: launch.onExit });
    }
    return running.address;
  }

  /** Lets one client go; the last one stops the server. Resolves once it is gone. */
  async release(owner: string): Promise<void> {
    if (!this.#owners.delete(owner)) return;
    if (this.#owners.size > 0) return;
    await this.#stop();
  }

  /** Stops the server whatever its clients say; the server is shutting down. */
  async closeAll(): Promise<void> {
    this.#owners.clear();
    await this.#stop();
  }

  /** The address of the running server, or a started one; concurrent callers share one start. */
  async #ensure(launch: OpenCodeServerLaunch): Promise<RunningServer> {
    if (this.#running !== undefined) return this.#running;
    if (this.#starting !== undefined) return this.#starting;
    if (this.#stopping !== undefined) await this.#stopping;
    if (this.#running !== undefined) return this.#running;
    const starting = this.#start(launch);
    this.#starting = starting;
    try {
      return await starting;
    } finally {
      if (this.#starting === starting) this.#starting = undefined;
    }
  }

  async #start(launch: OpenCodeServerLaunch): Promise<RunningServer> {
    // A server a previous Corral run left behind holds the same data directory; two servers on
    // one of them is the thing the record exists to refuse. Only on a first start: a live server
    // of this run has no record of its own to release.
    await releasePreviousWriter(
      this.#recordPath,
      this.#identityOfPid === undefined ? {} : { identityOfPid: this.#identityOfPid },
    );
    // The password is read from the server's own line, so a value the user's environment carries
    // must not override it (measured: with `OPENCODE_SERVER_PASSWORD` set, no line is printed).
    const env = { ...launch.env };
    delete env["OPENCODE_SERVER_PASSWORD"];
    delete env["OPENCODE_PASSWORD"];
    let child: ChildProcess;
    try {
      child = spawn(launch.command, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
        cwd: launch.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      throw new Error(`could not start ${launch.command} serve: ${messageOf(error)}`, {
        cause: error,
      });
    }
    let exitedResolve: () => void = () => {};
    const exited = new Promise<void>((resolve) => (exitedResolve = resolve));
    const running: RunningServer = { child, address: { url: "", password: "" }, exited };

    const address = await new Promise<OpenCodeServerAddress>((resolve, reject) => {
      let url: string | undefined;
      let password: string | undefined;
      let buffer = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== undefined) reject(error);
        else resolve({ url: url!, password: password! });
      };
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              `the opencode server did not report its address within ${this.#readyTimeoutMs} ms`,
            ),
          ),
        Math.max(1, this.#readyTimeoutMs),
      );
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trimEnd();
          buffer = buffer.slice(newline + 1);
          const listening = /^server listening on (http:\/\/\S+)/.exec(line);
          if (listening?.[1] !== undefined) url = listening[1];
          const reported = /^server password (\S+)/.exec(line);
          if (reported?.[1] !== undefined) password = reported[1];
          if (url !== undefined && password !== undefined) finish();
          newline = buffer.indexOf("\n");
        }
      });
      // Diagnostics only; never logged, and drained so the child cannot block on a full pipe.
      child.stderr?.resume();
      child.once("error", (error) =>
        finish(new Error(`could not start ${launch.command} serve: ${messageOf(error)}`)),
      );
      child.once("exit", (code, signal) => {
        exitedResolve();
        const reason = `the opencode server ${exitReason(code, signal)}`;
        // Before it reported its address, this is the start's failure, not an exit to report.
        finish(new Error(`the opencode server ${reason}`));
        this.#onServerGone(running, reason);
      });
    }).catch(async (error: unknown) => {
      // A start that never became a server must not leave a process behind.
      await stopProcess(child, 0);
      throw error;
    });
    running.address = address;
    if (child.pid !== undefined) recordWriter(this.#recordPath, child.pid);
    this.#running = running;
    return running;
  }

  /** The server died or was stopped: its clients learn why, and the next acquire starts a new one. */
  #onServerGone(running: RunningServer, reason: string): void {
    if (this.#running !== running) return;
    this.#running = undefined;
    releaseWriter(this.#recordPath);
    const attachments = [...this.#owners.values()];
    this.#owners.clear();
    for (const attachment of attachments) {
      try {
        attachment.onExit?.(reason);
      } catch {
        // A client that throws here must not keep the others from learning.
      }
    }
  }

  #stop(): Promise<void> {
    if (this.#stopping !== undefined) return this.#stopping;
    const running = this.#running;
    if (running === undefined) return Promise.resolve();
    const stopping = (async () => {
      await stopProcess(running.child, this.#exitGraceMs);
      await running.exited;
      this.#onServerGone(running, "the opencode server stopped");
    })().finally(() => {
      if (this.#stopping === stopping) this.#stopping = undefined;
    });
    this.#stopping = stopping;
    return stopping;
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
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return child.exitCode !== null || child.signalCode !== null;
}

function exitReason(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) return `was killed by ${signal}`;
  return `exited with code ${code ?? "unknown"}`;
}
