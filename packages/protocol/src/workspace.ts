/**
 * A task's workspace that is gone from disk is one named state (`design.md`, **Domain model**):
 * the session launch and the Changes read say this sentence, and the remove dialog recognizes it
 * to say the directory was already gone. It lives in the protocol package so the server that
 * writes it and the client that reads it cannot drift.
 *
 * It is not a wire field: `Session.launchError` and `TaskChanges.error` already carry a string.
 */
const MISSING_PREFIX = "This task's workspace no longer exists at ";
const MISSING_SUFFIX = ". Restore it or remove the task.";

/** The sentence, with the absolute path the task recorded. */
export function workspaceMissingMessage(path: string): string {
  return `${MISSING_PREFIX}${path}${MISSING_SUFFIX}`;
}

/** The path a missing-workspace sentence names; `undefined` for any other message. */
export function workspaceMissingPath(message: string): string | undefined {
  if (!message.startsWith(MISSING_PREFIX) || !message.endsWith(MISSING_SUFFIX)) return undefined;
  const path = message.slice(MISSING_PREFIX.length, message.length - MISSING_SUFFIX.length);
  return path === "" ? undefined : path;
}
