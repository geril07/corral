import { MissingEnvRefError, ReservedEnvRefError } from "../agents/launch-env.ts";
import {
  AgentDisabledError,
  AgentNotFoundError,
  LaunchModelInvalidError,
  LaunchModelUnsupportedError,
  LaunchProfileChangedError,
  LaunchProfileKindMismatchError,
  LaunchProfileRevisionWithoutProfileError,
  LaunchProfileUnknownError,
  LaunchSpawnError,
  LaunchViewUnsupportedError,
} from "./errors.ts";

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,31}$/;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/**
 * A diagnostic for an unexpected launch failure. Error messages and stacks may have captured a
 * value the profile injected, so every non-empty referenced value is replaced before the text
 * leaves this function. Redaction happens before the first line is taken for `LAUNCH_FAILED`.
 */
export function redactLaunchError(error: unknown, values: Iterable<string>): string {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`
      : "unexpected launch failure";
  const secrets = [...new Set(values)]
    .filter((value) => value !== "")
    .toSorted((left, right) => right.length - left.length);
  const redacted =
    secrets.length === 0
      ? text
      : text.replace(new RegExp(secrets.map(escapeRegExp).join("|"), "g"), "[redacted]");
  const bounded = redacted.length > 4000 ? `${redacted.slice(0, 4000)}…` : redacted;
  // The OS code is safe and stays outside the redacted text, so a short token cannot erase it.
  const code = errorCode(error);
  return code === undefined ? bounded : `${code}: ${bounded}`;
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
    error instanceof AgentDisabledError ||
    error instanceof AgentNotFoundError ||
    error instanceof LaunchViewUnsupportedError ||
    error instanceof LaunchProfileUnknownError ||
    error instanceof LaunchProfileChangedError ||
    error instanceof LaunchProfileRevisionWithoutProfileError ||
    error instanceof LaunchProfileKindMismatchError ||
    error instanceof LaunchModelUnsupportedError ||
    error instanceof LaunchModelInvalidError
  ) {
    return error.message;
  }
  return `the session could not be launched (${classification(error)})`;
}

/** The redacted text for the log; only a wrapped spawn error or a known choice error is quoted. */
export function launchDiagnostic(error: unknown): string {
  if (error instanceof LaunchSpawnError) return error.diagnostic;
  if (
    error instanceof MissingEnvRefError ||
    error instanceof ReservedEnvRefError ||
    error instanceof AgentDisabledError ||
    error instanceof AgentNotFoundError ||
    error instanceof LaunchViewUnsupportedError ||
    error instanceof LaunchProfileChangedError ||
    error instanceof LaunchProfileRevisionWithoutProfileError ||
    error instanceof LaunchProfileKindMismatchError ||
    error instanceof LaunchModelUnsupportedError ||
    error instanceof LaunchModelInvalidError
  ) {
    return `${error.name}: ${error.message}`;
  }
  return `the session could not be launched (${classification(error)}); native message not quoted`;
}

function classification(error: unknown): string {
  const name = error instanceof Error && SAFE_NAME.test(error.name) ? error.name : "Error";
  const code = errorCode(error);
  return code === undefined ? name : `${name} ${code}`;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code: unknown = error.code;
  return typeof code === "string" && SAFE_CODE.test(code) ? code : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
