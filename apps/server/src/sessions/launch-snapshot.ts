import { NATIVE_MODEL_ID, type LaunchProfile } from "@corral/protocol/config";
import type { LaunchSnapshot, SessionKind } from "@corral/protocol/rpc";
import { supportsModel } from "../agents/launch-capabilities.ts";
import {
  LaunchModelInvalidError,
  LaunchModelUnsupportedError,
  LaunchProfileKindMismatchError,
} from "./errors.ts";

/**
 * The immutable choices a new session starts with. `null` means the unchanged default launch.
 * A model override is validated here, before anything is spawned: an agent without a model flag
 * refuses it rather than starting on its default and letting the UI claim otherwise.
 */
export function launchSnapshotFor(options: {
  kind: SessionKind;
  profile: LaunchProfile | undefined;
  modelOverride: string | undefined;
}): LaunchSnapshot | null {
  const { kind, profile, modelOverride } = options;
  if (profile === undefined && modelOverride === undefined) return null;
  if (profile !== undefined && profile.agent !== kind) {
    throw new LaunchProfileKindMismatchError(profile.id, kind);
  }
  // A shell has no launch flags; reaching here means a model was asked for it.
  if (kind === "shell") throw new LaunchModelUnsupportedError(kind);
  if (modelOverride !== undefined) {
    if (!supportsModel(kind)) throw new LaunchModelUnsupportedError(kind);
    if (!NATIVE_MODEL_ID.test(modelOverride)) throw new LaunchModelInvalidError(kind);
  }
  return {
    kind: profile?.agent ?? kind,
    profile:
      profile === undefined
        ? null
        : { id: profile.id, name: profile.name, revision: profile.revision },
    model: modelOverride ?? profile?.model ?? null,
    provider: profile?.provider ?? null,
    env: profile?.env ?? [],
  };
}
