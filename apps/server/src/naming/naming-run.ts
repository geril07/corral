import type { EnvRef } from "@corral/protocol/config";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isExecutable } from "../agents/executable-lookup.ts";
import { resolveEnvRefs } from "../agents/launch-env.ts";
import { ProcessFailure, runProcess } from "../process/run-process.ts";
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

/**
 * One naming run through the server's single spawner (`process/run-process.ts`): its own process
 * group, a deadline that kills the group (so a helper the agent started dies too), a bounded answer,
 * and an end at the child's `exit` rather than at `close` — a descendant that kept the pipes open
 * would otherwise have held a finished run past its timeout.
 */
async function spawnNaming(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<NamingRun> {
  try {
    const result = await runProcess({
      command,
      args: [...args],
      cwd: options.cwd,
      env: options.env,
      timeoutMs: Math.max(1, options.timeoutMs),
      maxBufferBytes: MAX_STDOUT_CHARS,
      signal: undefined,
    });
    if (result.exitCode === 0) return { ok: true, stdout: result.stdout };
    return {
      ok: false,
      reason: `${command} exited with ${result.exitCode ?? result.signal ?? "no code"}`,
    };
  } catch (error) {
    if (!(error instanceof ProcessFailure)) {
      return { ok: false, reason: messageOf(error) };
    }
    switch (error.kind) {
      case "timeout":
        return { ok: false, reason: `no answer within ${seconds(options.timeoutMs)}` };
      case "overflow":
        return { ok: false, reason: "the answer was too large" };
      case "missing":
      case "missing-directory":
      case "spawn":
        return { ok: false, reason: `could not start ${command}: ${messageOf(error.cause)}` };
      case "aborted":
      default:
        return { ok: false, reason: "the answer was abandoned" };
    }
  }
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
