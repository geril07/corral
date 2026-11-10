import type { EnvRef } from "@corral/protocol/config";

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Variables Corral owns or needs for its own process. */
const RESERVED_EXACT: ReadonlySet<string> = new Set([
  "TERM",
  "PATH",
  "SHELL",
  "HOME",
  "BASH_ENV",
  "ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PI_PACKAGE_DIR",
]);

const RESERVED_PREFIXES = ["CORRAL_", "XDG_", "LD_", "DYLD_", "PI_CODING_AGENT_"];

/** Block process control and unintegrated config overrides, except the three named native roots. */
export function isReservedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (NATIVE_ROOTS.has(upper)) return false;
  return (
    RESERVED_EXACT.has(upper) ||
    RESERVED_PREFIXES.some((prefix) => upper.startsWith(prefix)) ||
    upper.endsWith("_HOME") ||
    upper.includes("CONFIG")
  );
}

const NATIVE_ROOTS = new Set(["CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR"]);

export type InstanceEnvEntry = EnvRef | { targetName: string; value: string };

/** Resolve against an explicit server environment without modifying it. */
export function resolveInstanceEnv(
  entries: readonly InstanceEnvEntry[],
  source: NodeJS.ProcessEnv,
  profileId: string,
  home: string,
): NodeJS.ProcessEnv {
  const result = { ...source };
  for (const entry of entries) {
    if (isReservedEnvName(entry.targetName)) throw new ReservedEnvRefError(entry.targetName);
    const value = "value" in entry ? entry.value : source[entry.fromEnv];
    if (value === undefined)
      throw new MissingEnvRefError(
        profileId,
        "fromEnv" in entry ? entry.fromEnv : entry.targetName,
      );
    result[entry.targetName] =
      NATIVE_ROOTS.has(entry.targetName.toUpperCase()) && (value === "~" || value.startsWith("~/"))
        ? home + value.slice(1)
        : value;
  }
  return result;
}

export class MissingEnvRefError extends Error {
  readonly profileId: string | null;
  readonly variable: string;
  constructor(profileId: string | null, variable: string) {
    super(
      `the server has no environment variable ${variable}${profileId ? ` for profile ${profileId}` : ""}`,
    );
    this.profileId = profileId;
    this.variable = variable;
  }
}

export class ReservedEnvRefError extends Error {
  readonly variable: string;
  constructor(variable: string) {
    super(`a launch environment reference may not set ${variable}`);
    this.variable = variable;
  }
}

/**
 * Reads every referenced value from `source` once, before anything is spawned. There is no
 * fallback: a name the server does not have fails the launch instead of letting the agent use
 * ambient credentials. The returned values never go to the config file, the protocol, SQLite or
 * argv; they exist only in the child's environment.
 */
export function resolveEnvRefs(
  refs: readonly EnvRef[],
  source: NodeJS.ProcessEnv,
  profileId: string | null,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const ref of refs) {
    // A snapshot written by an older or hand-edited build is filtered again here, not trusted.
    if (isReservedEnvName(ref.targetName)) throw new ReservedEnvRefError(ref.targetName);
    const value = source[ref.fromEnv];
    if (value === undefined) throw new MissingEnvRefError(profileId, ref.fromEnv);
    resolved[ref.targetName] = value;
  }
  return resolved;
}
