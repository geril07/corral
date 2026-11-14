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
