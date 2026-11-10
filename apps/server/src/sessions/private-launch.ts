import type { AgentKind } from "@corral/protocol/config";
import { z } from "zod";
import { instanceArgsProblem } from "../agents/instance-args.ts";

/**
 * The launch data that must not reach a client: the executable and instance argv captured for a
 * session, and the literal environment values its instance supplied. It is persisted beside the
 * public `LaunchSnapshot` (in the `session_launch_specs` table), so a restart resumes what the
 * session started with even after the instance was edited, disabled
 * or deleted. Referenced environment entries stay in the public snapshot as names and are resolved
 * against the server environment again on every launch; only literal values are stored here.
 */
export const PrivateLaunchSpec = z.object({
  /** The instance selected at start, if any. Kept for identity, never used to re-read config. */
  instanceId: z.string().nullable(),
  /** The executable that launch resolved, so a later `[agents.<kind>].command` edit cannot move it. */
  command: z.string(),
  /** The instance's own argv, without any Corral-owned flag. */
  args: z.array(z.string()),
  /** Literal environment values, resolved once and never sent to a client or a log. */
  literalEnv: z.array(z.object({ targetName: z.string(), value: z.string() })),
});
export type PrivateLaunchSpec = z.infer<typeof PrivateLaunchSpec>;

/**
 * Whether a launch may add this instance argv. Pi accepts the same non-owning switches model
 * discovery accepts (the policy is `agents/instance-args.ts`); every other driver builds its own
 * argv and has no seam for instance flags, so it refuses them instead of silently dropping them.
 */
export function instanceLaunchArgsProblem(
  kind: AgentKind,
  args: readonly string[],
): string | undefined {
  if (args.length === 0) return undefined;
  if (kind === "pi") return instanceArgsProblem(kind, args);
  return `the ${kind} agent does not support extra launch arguments; remove them from the instance`;
}
