import type { EnvRef } from "@corral/protocol/config";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isExecutable } from "../agents/executable-lookup.ts";
import { resolveEnvRefs } from "../agents/launch-env.ts";
import { namingArgs, type NamingLaunch } from "./naming-command.ts";

/** A naming request as the config resolved it. */
export interface NamingRunRequest {
  launch: NamingLaunch;
  /** The executable to spawn; a `[agents.<kind>].command` override, else the agent's name. */
  command: string;
  /** The profile's environment references, resolved as for a launch. */
  env: readonly EnvRef[];
  profileId: string | null;
  timeoutMs: number;
  /** The whole template, prompt included. */
  prompt: string;
}

export type NamingRun =
  | { ok: true; stdout: string }
  /** `reason` never carries the prompt, stdout, stderr or an environment value. */
  | { ok: false; reason: string };

/** A response larger than this is not a name; the child is stopped rather than buffered further. */
const MAX_STDOUT_CHARS = 1024 * 1024;

/**
 * Runs one naming request to completion: the agent in its non-interactive mode, in a temporary
 * directory (never the repository), with the profile's environment references resolved. A missing
 * executable, a non-zero exit, a timeout or too much output is a failure with a loggable reason;
 * nothing is retried. The temporary directory is always removed.
 */
export async function runNaming(request: NamingRunRequest): Promise<NamingRun> {
  const args = namingArgs(request.launch, request.prompt);
  if (args === undefined)
    return { ok: false, reason: `${request.launch.kind} cannot run without saving a session` };
  let env: Record<string, string>;
  try {
    env = stringEnv({
      ...process.env,
      ...resolveEnvRefs(request.env, process.env, request.profileId),
    });
  } catch (error) {
    return { ok: false, reason: messageOf(error) };
  }
  const command = request.command;
  if (!isExecutable(command, env["PATH"]))
    return { ok: false, reason: `no executable ${command} the server can run` };
  let cwd: string;
  try {
    cwd = await mkdtemp(join(tmpdir(), "corral-naming-"));
  } catch (error) {
    return { ok: false, reason: `no temporary directory: ${messageOf(error)}` };
  }
  try {
    return await spawnNaming(command, args, { cwd, env, timeoutMs: request.timeoutMs });
  } catch (error) {
    return { ok: false, reason: messageOf(error) };
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}

function spawnNaming(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<NamingRun> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a timeout stops helpers the agent started too.
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let settled = false;
    const finish = (result: NamingRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const stop = () => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
          return;
        }
      } catch {
        // The group is gone; the child handle still knows how to stop it.
      }
      child.kill("SIGKILL");
    };
    // A descendant that left the group can hold the stdio pipes open forever. The answer is
    // already lost, so the timer finishes on its own instead of waiting for `close`.
    const abandon = (reason: string) => {
      stop();
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ ok: false, reason });
    };
    const timer = setTimeout(
      () => abandon(`no answer within ${seconds(options.timeoutMs)}`),
      Math.max(1, options.timeoutMs),
    );
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_STDOUT_CHARS) abandon("the answer was too large");
    });
    // Drained, never logged: stderr may repeat the prompt or a credential.
    child.stderr?.resume();
    child.once("error", (error) =>
      finish({ ok: false, reason: `could not start ${command}: ${messageOf(error)}` }),
    );
    // The normal path: `close` fires once the child and every pipe it owns are gone.
    child.once("close", (code, signal) => {
      if (code !== 0)
        return finish({
          ok: false,
          reason: `${command} exited with ${code ?? signal ?? "no code"}`,
        });
      finish({ ok: true, stdout });
    });
  });
}

function seconds(milliseconds: number): string {
  return `${Math.max(1, Math.round(milliseconds / 1000))}s`;
}

function stringEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
