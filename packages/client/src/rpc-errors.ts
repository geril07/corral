import type { ChatUnavailableReason } from "@corral/protocol/rpc";

/**
 * The typed errors of the contract (`rpc.ts`) that the UI explains in its own words. Matched by
 * shape rather than `instanceof`: a browser can hold more than one copy of the client package,
 * which is why oRPC itself carries a `Symbol.hasInstance` workaround, and `launch-error.ts`
 * already matches by shape.
 */
function definedError(error: unknown): { code: string; data: unknown } | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (Reflect.get(error, "defined") !== true) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? { code, data: Reflect.get(error, "data") } : undefined;
}

function field(data: unknown, key: string): unknown {
  return typeof data === "object" && data !== null ? Reflect.get(data, key) : undefined;
}

/** Why a chat call was refused, for a caller deciding whether a retry can help. */
export function chatUnavailableReason(error: unknown): ChatUnavailableReason | undefined {
  const defined = definedError(error);
  if (defined?.code !== "CHAT_UNAVAILABLE") return undefined;
  const reason = field(defined.data, "reason");
  return reason === "no-driver" || reason === "not-started" || reason === "exited"
    ? reason
    : undefined;
}

/** The files that block removing a task's worktree, when that is why the call failed. */
export function dirtyWorktreeFiles(error: unknown): string[] | undefined {
  const defined = definedError(error);
  if (defined?.code !== "WORKTREE_DIRTY") return undefined;
  const files = field(defined.data, "files");
  return Array.isArray(files) ? files.map(String) : [];
}

function providerName(data: unknown): string {
  return field(data, "provider") === "gitlab" ? "GitLab" : "GitHub";
}

/** A sentence for the user. Git's own message is shown as it is: it is written for people. */
export function describeError(error: unknown): string {
  const defined = definedError(error);
  if (defined) {
    const { code, data } = defined;
    switch (code) {
      case "NOT_A_GIT_REPOSITORY":
        return `${String(field(data, "path"))} is not inside a git repository.`;
      case "PROJECT_EXISTS":
        return "This repository is already added.";
      case "GIT_FAILED":
        return String(field(data, "message"));
      case "PROJECT_NOT_FOUND":
        return "This project no longer exists.";
      case "TASK_NOT_FOUND":
        return "This task no longer exists.";
      case "NOT_FOUND":
        return "This terminal no longer exists.";
      case "SESSION_NOT_FOUND":
        return "This session no longer exists.";
      case "CHAT_UNAVAILABLE":
        // The server's own sentence; the RPC message is only the code.
        return String(field(data, "message"));
      case "ALREADY_RUNNING":
        return "This session is already running.";
      case "AGENT_NOT_FOUND": {
        const command = String(field(data, "command"));
        // A `[agents.<kind>].command` is an absolute path (on either separator), so PATH is not
        // where it was looked for; the server's own `isAbsolute` is the authority.
        return /[\\/]/.test(command)
          ? `${command} is not an executable the server can run.`
          : `${command} was not found on the server's PATH.`;
      }
      case "AGENT_DISABLED":
        return `The ${String(field(data, "kind"))} agent is disabled in the config file.`;
      case "CHAT_MODEL_UNSUPPORTED":
        return `The agent does not offer the model ${String(field(field(data, "model"), "id"))}.`;
      case "CHAT_REASONING_UNSUPPORTED":
        return `The agent has no reasoning level "${String(field(data, "level"))}".`;
      case "LAUNCH_PROFILE_CHANGED":
        return "The launch profile changed since you chose it. Reload and choose it again.";
      case "LAUNCH_PROFILE_REVISION_UNSUPPORTED":
        return "A pinned profile revision requires a selected profile.";
      case "HAS_LIVE_TERMINALS":
        return "The project has tasks with running terminals. Close them first.";
      case "BAD_REQUEST":
        return String(field(data, "message"));
      case "WORKTREE_DIRTY":
        return "The worktree has uncommitted changes.";
      // Local links in chat: the path refusals say why, so a click that fails is not a mystery.
      case "FILE_OUTSIDE_WORKSPACE":
        return `${String(field(data, "path"))} is outside this task's workspace.`;
      case "FILE_NOT_FOUND":
        return `${String(field(data, "path"))} does not exist any more.`;
      case "FILE_IS_DIRECTORY":
        return `${String(field(data, "path"))} is a directory, not a file.`;
      case "FILE_TOO_LARGE":
        return `${String(field(data, "path"))} is too large to preview (${String(field(data, "size"))} bytes).`;
      case "FILE_TYPE_UNSUPPORTED":
        return `${String(field(data, "path"))} is not an image or a video.`;
      case "FILE_UNREADABLE":
        return `${String(field(data, "path"))} could not be read.`;
      case "FILE_CHANGED":
        return `${String(field(data, "path"))} changed while Corral was reading it. Try again.`;
      case "EDITOR_UNSET":
        return String(field(data, "reason"));
      case "EDITOR_NOT_FOUND":
        return `${String(field(data, "command"))} is not an executable the server can run.`;
      case "ISSUE_URL_INVALID":
        return String(field(data, "message"));
      case "ISSUE_PROVIDER_REQUIRED":
        return `Choose whether ${String(field(data, "host"))} runs GitHub or GitLab.`;
      case "ISSUE_HOST_UNTRUSTED":
        return `${String(field(data, "host"))} is not a configured ${providerName(data)} host for this project. Add it as a git remote or set ${field(data, "provider") === "gitlab" ? "GITLAB_HOST" : "GH_HOST"} on the server, or create the task manually.`;
      case "ISSUE_UNSUPPORTED_PORT":
        return `GitHub issues on a nonstandard port are not supported. Use a standard host or create the task manually.`;
      case "ISSUE_CLI_MISSING":
        return `${String(field(data, "command"))} was not found on the server's PATH.`;
      case "ISSUE_AUTH_REQUIRED":
        return `The server's ${providerName(data)} CLI is not logged in for this host.`;
      case "ISSUE_FETCH_TIMEOUT":
        return "Reading the issue timed out. You can create the task without its metadata.";
      case "ISSUE_RESPONSE_INVALID":
        return "The issue tool returned something Corral could not read.";
      case "ISSUE_FETCH_FAILED":
        return String(field(data, "message"));
    }
  }
  return error instanceof Error ? error.message : String(error);
}
