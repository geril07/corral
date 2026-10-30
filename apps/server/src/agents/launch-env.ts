import type { EnvRef } from "@corral/protocol/config";

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Variables Corral owns, needs for its own process, or uses to locate an agent's config/home. */
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

/**
 * A profile may add credentials to the agent's environment, not redirect the agent to another
 * config directory or home: restart discovery reads the same variables, and a launch that wrote
 * history elsewhere would be orphaned. `*_HOME` and `*CONFIG*` cover the agents' documented
 * overrides (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `OPENCODE_CONFIG*`); `PI_CODING_AGENT_*` covers
 * pi's config, session-store and package paths, and `PI_PACKAGE_DIR` its loader path. Comparisons
 * are case-insensitive, as on Windows; on POSIX names are case-sensitive but reserving both cases
 * is the smaller promise.
 */
export function isReservedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    RESERVED_EXACT.has(upper) ||
    RESERVED_PREFIXES.some((prefix) => upper.startsWith(prefix)) ||
    upper.endsWith("_HOME") ||
    upper.includes("CONFIG")
  );
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
