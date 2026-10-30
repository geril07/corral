import { MissingEnvRefError, ReservedEnvRefError } from "../agents/launch-env.ts";
import {
  AgentNotFoundError,
  LaunchModelInvalidError,
  LaunchModelUnsupportedError,
  LaunchProfileKindMismatchError,
  LaunchSpawnError,
} from "./errors.ts";

/**
 * A diagnostic for an unexpected launch failure. Error messages and stacks may have captured a
 * value the profile injected, so every referenced value is replaced before the text leaves this
 * function. The result goes to the server log and, as a first line, to the safe launch error.
 */
export function redactLaunchError(error: unknown, values: Iterable<string>): string {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`
      : String(error);
  const secrets = [...new Set(values)]
    .filter((value) => value.length >= 4)
    .toSorted((left, right) => right.length - left.length);
  let redacted = text;
  for (const secret of secrets) redacted = redacted.split(secret).join("[redacted]");
  return redacted.length > 4000 ? `${redacted.slice(0, 4000)}…` : redacted;
}

/** What a later client sees: a known choice/reference error, or the redacted first diagnostic line. */
export function launchFailureReason(error: unknown): string {
  if (error instanceof MissingEnvRefError) {
    return `the server has no environment variable ${error.variable}${
      error.profileId === null ? "" : ` for profile ${error.profileId}`
    }`;
  }
  if (error instanceof ReservedEnvRefError) {
    return "the saved launch sets a reserved environment variable";
  }
  if (error instanceof LaunchSpawnError) return error.summary;
  if (
    error instanceof AgentNotFoundError ||
    error instanceof LaunchProfileKindMismatchError ||
    error instanceof LaunchModelUnsupportedError ||
    error instanceof LaunchModelInvalidError
  ) {
    return error.message;
  }
  return "the session could not be launched; see the server log";
}

/** The redacted text for the log; only a wrapped spawn error or a known choice error is quoted. */
export function launchDiagnostic(error: unknown): string {
  if (error instanceof LaunchSpawnError) return error.diagnostic;
  if (
    error instanceof MissingEnvRefError ||
    error instanceof ReservedEnvRefError ||
    error instanceof AgentNotFoundError ||
    error instanceof LaunchProfileKindMismatchError ||
    error instanceof LaunchModelUnsupportedError ||
    error instanceof LaunchModelInvalidError
  ) {
    return `${error.name}: ${error.message}`;
  }
  return "the session could not be launched";
}
