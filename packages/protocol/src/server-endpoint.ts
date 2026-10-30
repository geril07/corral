import { z } from "zod";

/** What a running server publishes in its state directory so clients can find it. */
export const ServerEndpoint = z.object({
  pid: z.number().int().positive(),
  /** WebSocket base URL, e.g. `ws://127.0.0.1:4000`. */
  url: z.string(),
  protocolVersion: z.number().int(),
  /** Epoch milliseconds. */
  startedAt: z.number(),
});
export type ServerEndpoint = z.infer<typeof ServerEndpoint>;

/**
 * Exit code of a server that did not start because another instance holds the lock (or its
 * lock cannot be judged). Launchers keep waiting for the other server's endpoint on this code.
 */
export const SERVER_LOCK_REFUSED_EXIT_CODE = 75;

// Plain string joins: protocol stays free of Node imports, and Node accepts `/` on every platform.

/** `$CORRAL_STATE_DIR`, else `$XDG_STATE_HOME/corral`, else `~/.local/state/corral`. */
export function resolveStateDir(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): string {
  if (env["CORRAL_STATE_DIR"]) return env["CORRAL_STATE_DIR"];
  const stateHome = env["XDG_STATE_HOME"] || `${homeDir}/.local/state`;
  return `${stateHome}/corral`;
}

export function endpointFilePath(stateDir: string): string {
  return `${stateDir}/endpoint.json`;
}
