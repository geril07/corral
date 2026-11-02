import { execFile } from "node:child_process";

/**
 * The Codex CLI the driver was measured against (`.e2e/stage-c/c3/probe/`). 0.166.0's app-server
 * is labelled experimental and its JSON-RPC surface is not a compatibility promise, so an
 * untested version gets a visible refusal instead of a driver that half-works. The terminal stays
 * available: without a tested version the session launches plain `codex`, and chat refuses.
 */
export const TESTED_CODEX_VERSION = "0.166.0";

/** `codex --version` prints `codex-cli 0.166.0`; a bare `0.166.0` is accepted too. */
export function parseCodexVersion(output: string): string | undefined {
  const match = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/.exec(output.trim());
  return match?.[1];
}

/**
 * How long `codex --version` may take. A wrapper that hangs must not hold a launch: the answer is
 * "unknown", which is treated as unsupported.
 */
const VERSION_TIMEOUT_MS = 5000;

const cache = new Map<string, Promise<string | undefined>>();

/**
 * The version the executable reports, or `undefined` when it could not be read. Cached per
 * executable for the process lifetime: the binary behind `[agents.codex].command` does not change
 * under a running server, and every launch would otherwise pay for a second `execFile`.
 */
export function codexVersion(
  command: string,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  const cached = cache.get(command);
  if (cached !== undefined) return cached;
  const reading = new Promise<string | undefined>((resolve) => {
    execFile(
      command,
      ["--version"],
      { env, timeout: VERSION_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        const version = error === null ? parseCodexVersion(stdout) : undefined;
        // A failure is not cached: a binary that was missing, busy or broken for one launch must be
        // measured again next time instead of refusing chat for the rest of the process's life.
        if (version === undefined) cache.delete(command);
        resolve(version);
      },
    );
  });
  cache.set(command, reading);
  return reading;
}

/**
 * Whether chat may run against this executable, and why not. The terminal launch uses the same
 * answer: a tested version gets the Corral app-server (both views live), an untested one keeps
 * stage A's plain `codex` launch (its own daemon) and chat is refused with this sentence.
 */
export async function codexChatSupport(
  command: string,
  env: Record<string, string | undefined>,
): Promise<{ supported: true; version: string } | { supported: false; reason: string }> {
  const version = await codexVersion(command, env);
  if (version === TESTED_CODEX_VERSION) return { supported: true, version };
  if (version === undefined)
    return {
      supported: false,
      reason: `could not read the version of ${command}; chat for Codex needs ${TESTED_CODEX_VERSION}, the version this build was measured against. Open the session as a terminal.`,
    };
  return {
    supported: false,
    reason: `Codex ${version} is not the version this build's chat was measured against (${TESTED_CODEX_VERSION}). Open the session as a terminal.`,
  };
}

/** Test seam: forget what was read, so a swapped executable is measured again. */
export function resetCodexVersionCache(): void {
  cache.clear();
}
