import { workspaceMissingPath } from "@corral/protocol/workspace";

interface DefinedError {
  code: string;
  data: unknown;
}

function definedError(error: unknown): DefinedError | undefined {
  if (typeof error !== "object" || error === null || Reflect.get(error, "defined") !== true) {
    return undefined;
  }
  const code = Reflect.get(error, "code");
  if (typeof code !== "string") return undefined;
  return { code, data: Reflect.get(error, "data") };
}

/** The contract code of a typed error, for callers that branch on one refusal. */
export function launchErrorCode(error: unknown): string | undefined {
  return definedError(error)?.code;
}

/**
 * The typed launch errors of `sessions.start` and `restart`, in the user's words. Matched by
 * shape, like `@corral/client/rpc-errors`, so a web module needs no dependency on the RPC client.
 * `undefined` means another error: the caller falls back to `describeError`.
 */
export function describeLaunchError(error: unknown): string | undefined {
  const defined = definedError(error);
  if (defined === undefined) return undefined;

  switch (defined.code) {
    case "LAUNCH_PROFILE_UNKNOWN":
      return `The profile "${String(field(defined.data, "id"))}" is no longer in the config file.`;
    case "LAUNCH_PROFILE_CHANGED":
      return `The profile "${String(field(defined.data, "id"))}" changed on the server. Review it and choose it again.`;
    case "LAUNCH_PROFILE_REVISION_UNSUPPORTED":
      return "A pinned profile revision needs a selected profile.";
    case "LAUNCH_PROFILE_KIND_MISMATCH":
      return `The profile "${String(field(defined.data, "id"))}" does not start a ${String(field(defined.data, "kind"))} session.`;
    case "LAUNCH_MODEL_UNSUPPORTED":
      return `${String(field(defined.data, "kind"))} has no model choice at launch.`;
    case "LAUNCH_MODEL_INVALID":
      return `That is not a valid model id for ${String(field(defined.data, "kind"))}.`;
    case "LAUNCH_ENV_MISSING": {
      const profileId = field(defined.data, "profileId");
      const name = String(field(defined.data, "name"));
      return typeof profileId === "string"
        ? `The server has no environment variable ${name} for profile "${profileId}".`
        : `The server has no environment variable ${name}.`;
    }
    case "AGENT_DISABLED":
      return `The ${String(field(defined.data, "kind"))} agent is disabled in the config file.`;
    case "LAUNCH_ENV_RESERVED":
      return `A profile may not set ${String(field(defined.data, "name"))}.`;
    case "LAUNCH_FAILED": {
      const message = String(field(defined.data, "message"));
      // A workspace gone from disk is already a sentence with its path; the launch wrapper would
      // only bury it. An unexpected spawn failure keeps the wrapper.
      if (workspaceMissingPath(message) !== undefined) return message;
      return `The ${String(field(defined.data, "kind"))} session could not be launched: ${message.replace(/\.$/, "")}.`;
    }
    default:
      return undefined;
  }
}

function field(data: unknown, key: string): unknown {
  return typeof data === "object" && data !== null ? Reflect.get(data, key) : undefined;
}
