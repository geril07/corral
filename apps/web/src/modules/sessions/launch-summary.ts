import { AGENT_LAUNCH_CAPABILITY } from "@corral/protocol/config";
import type { EnvRef } from "@corral/protocol/config";
import type { Session } from "@corral/protocol/rpc";

/**
 * What a session was actually launched with. Read only from the session's own immutable snapshot,
 * never from today's config: editing or deleting a profile changes nothing for an existing session.
 */
export interface LaunchFacts {
  /** The profile's name at launch; `null` for a launch without a profile. */
  profile: string | null;
  profileId: string | null;
  /** The snapshot's revision, so a name reused later is still distinguishable. */
  revision: string | null;
  model: string | null;
  provider: string | null;
  env: readonly EnvRef[];
}

/** `undefined`: an old server did not send launch choices, so nothing may be claimed about them. */
export function launchFacts(session: Pick<Session, "launch">): LaunchFacts | undefined {
  const launch = session.launch;
  if (launch === undefined) return undefined;
  if (launch === null) {
    return { profile: null, profileId: null, revision: null, model: null, provider: null, env: [] };
  }
  return {
    profile: launch.profile?.name ?? null,
    profileId: launch.profile?.id ?? null,
    revision: launch.profile?.revision ?? null,
    model: launch.model,
    provider: launch.provider,
    env: launch.env,
  };
}

/**
 * The compact suffix a sidebar row shows: the profile it was started with, else its model.
 * Nothing for a native-default launch and nothing for a session whose choices are unknown.
 */
export function compactLaunchLabel(session: Pick<Session, "launch">): string | undefined {
  const launch = session.launch;
  if (launch === undefined || launch === null) return undefined;
  return launch.profile?.name ?? launch.model ?? undefined;
}

/** "No model was chosen" still has to respect an agent with no model flag at all. */
function fallbackModel(kind: Session["kind"]): string {
  if (kind === "shell") return "no model";
  return AGENT_LAUNCH_CAPABILITY[kind].model ? "agent default model" : "no model choice";
}

/** One line for the stopped-session pane; `undefined` for a shell or an old server. */
export function launchLine(
  session: Pick<Session, "kind" | "launch">,
): { text: string; details: string } | undefined {
  if (session.kind === "shell") return undefined;
  const facts = launchFacts(session);
  if (facts === undefined) {
    return {
      text: "Started before Corral recorded launch choices; its model is unknown.",
      details: "This session was created by an older server, so Corral does not guess its model.",
    };
  }

  const model = facts.model ?? fallbackModel(session.kind);
  const parts = [
    ...(facts.profile === null ? [] : [facts.profile]),
    model,
    ...(facts.provider === null ? [] : [`provider ${facts.provider}`]),
  ];
  const detailParts = [
    facts.profileId === null ? "no profile" : `profile ${facts.profileId} (${facts.revision})`,
    `model ${facts.model ?? "agent default"}`,
    `provider ${facts.provider ?? "agent native"}`,
    ...facts.env.map((ref) => `env ${ref.targetName} from server ${ref.fromEnv}`),
  ];
  return { text: parts.join(" · "), details: detailParts.join("; ") };
}
