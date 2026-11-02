import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * One way to run a child process with a deadline, a bounded output and a closed stdin, for the two
 * callers that need it: `git` (writes and reads) and the native forge CLIs (`gh`, `glab`).
 *
 * The child gets its **own process group** (`detached: true`) so a deadline kills the whole tree: a
 * git hook or a wrapper that spawns a helper would otherwise survive the kill and hold the deadline
 * open. Settlement is on the child's **exit**, with the pipes read first and destroyed after a short
 * grace: `execFile` waits for `close`, and a grandchild that inherited the pipes (a fake CLI's
 * background sleep, a hook's daemon) would then hold the call far past its deadline — measured, a
 * 2 000 ms call resolved at 30 011 ms before this rule.
 */
export type ProcessFailureKind =
  /** The executable is not on `PATH`. */
  | "missing"
  /** `cwd` is gone, which also surfaces as a spawn error. */
  | "missing-directory"
  /** The child could not be started for another reason; `cause` is the original error. */
  | "spawn"
  /** More output than the caller allows. */
  | "overflow"
  /** The deadline fired; the process group was killed. */
  | "timeout"
  /** The caller's abort signal fired; the process group was killed. */
  | "aborted";

export class ProcessFailure extends Error {
  readonly kind: ProcessFailureKind;
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  override readonly cause: unknown;

  constructor(options: {
    kind: ProcessFailureKind;
    command: string;
    cwd: string;
    exitCode?: number | null;
    stderr?: string;
    stdout?: string;
    cause?: unknown;
  }) {
    super(`${options.command}: ${options.kind}`);
    this.kind = options.kind;
    this.command = options.command;
    this.cwd = options.cwd;
    this.exitCode = options.exitCode ?? null;
    this.stderr = options.stderr ?? "";
    this.stdout = options.stdout ?? "";
    this.cause = options.cause;
  }
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  /** `null` when a signal ended the child, which only happens outside our own kills. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * How long the pipes may still deliver data after the child exited. Long enough for a normal CLI's
 * last chunk, short enough that a grandchild holding the pipes cannot stretch the call.
 */
const EXIT_DRAIN_MS = 100;

export function runProcess(options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBufferBytes: number;
  signal: AbortSignal | undefined;
  /** Sent to the child's stdin, which is then closed; `--body-file -` reads it. */
  stdin?: string;
}): Promise<ProcessResult> {
  const { command, args, cwd, env, timeoutMs, maxBufferBytes, signal, stdin } = options;
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(command, args, {
      cwd,
      env,
      // Its own process group, so a deadline can kill a hook or a helper the child started.
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;

    const killGroup = () => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        // Negative pid: the group `detached` gave the child.
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    };

    const settle = (result: ProcessResult | ProcessFailure) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (drain !== undefined) clearTimeout(drain);
      signal?.removeEventListener("abort", abort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      if (result instanceof ProcessFailure) reject(result);
      else resolve(result);
    };

    const fail = (kind: ProcessFailureKind, extra: { cause?: unknown } = {}) =>
      settle(new ProcessFailure({ kind, command, cwd, stderr, stdout, ...extra }));

    /** Output over the bound is a refusal, and the group is killed so nothing keeps writing. */
    const append = (chunk: string, toStderr: boolean) => {
      if (settled) return;
      if (stdout.length + stderr.length + chunk.length > maxBufferBytes) {
        killGroup();
        fail("overflow");
        return;
      }
      if (toStderr) stderr += chunk;
      else stdout += chunk;
    };

    timer = setTimeout(() => {
      killGroup();
      fail("timeout");
    }, timeoutMs);
    const abort = () => {
      killGroup();
      fail("aborted");
    };
    signal?.addEventListener("abort", abort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => append(chunk, false));
    child.stderr?.on("data", (chunk: string) => append(chunk, true));
    child.stdout?.on("error", () => undefined);
    child.stderr?.on("error", () => undefined);

    // A child that never spawned has no pid, and writing into its stdin is a stream error the
    // `error` event below already reports; closing stdin at once is what makes a reader see EOF.
    if (child.pid !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(stdin ?? "");
    }

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        fail(existsSync(cwd) ? "missing" : "missing-directory", { cause: error });
        return;
      }
      fail("spawn", { cause: error });
    });

    // The normal end: every pipe is closed. `close` always follows `exit` for a well-behaved child.
    child.on("close", (code, closeSignal) => {
      settle({ stdout, stderr, exitCode: code, signal: closeSignal });
    });

    // A grandchild may hold the pipes open after the child itself exited. The call is over at
    // `exit`; the grace only lets the last chunk arrive.
    child.on("exit", (code, exitSignal) => {
      if (settled) return;
      drain = setTimeout(() => {
        settle({ stdout, stderr, exitCode: code, signal: exitSignal });
      }, EXIT_DRAIN_MS);
    });
  });
}
