import { AGENT_LAUNCH_CAPABILITY } from "@corral/protocol/config";
import type { AgentKind } from "@corral/protocol/rpc";

/**
 * A native model id, passed to the agent as one argv value. The server validates the same rule;
 * this copy only keeps the picker honest before a request (`docs/agent-profiles.md`).
 */
export const NATIVE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

/** What the user picked in the agent picker. A profile fixes the provider; none is chosen here. */
export interface AgentLaunchChoice {
  kind: AgentKind;
  profileId?: string;
  /** The revision the user saw, so the server refuses a profile that changed since. Only with a profile. */
  expectedProfileRevision?: string;
  /** Overrides the profile's model, or the agent's native default. */
  model?: string;
}

/** Whether the agent's launch command has a model flag at all (OpenCode 2.1.4 has none). */
export function supportsModel(kind: AgentKind): boolean {
  return AGENT_LAUNCH_CAPABILITY[kind].model;
}

/** A typed model field to the override the contract expects: an empty field is no override. */
export function modelOverride(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Why the typed model cannot be sent, or `undefined` when it can (or is not offered). */
export function modelProblem(kind: AgentKind, text: string): string | undefined {
  const model = modelOverride(text);
  if (model === undefined || !supportsModel(kind)) return undefined;
  return NATIVE_MODEL_ID.test(model)
    ? undefined
    : "Use a native model id (letters, digits and . _ : / @ + - only).";
}
