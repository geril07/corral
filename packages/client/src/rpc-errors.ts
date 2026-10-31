import { ORPCError } from "@orpc/client";

/** The typed errors of the contract (`rpc.ts`) that the UI explains in its own words. */
function definedError(error: unknown): { code: string; data: unknown } | undefined {
  return error instanceof ORPCError && error.defined
    ? { code: error.code, data: error.data }
    : undefined;
}

function field(data: unknown, key: string): unknown {
  return typeof data === "object" && data !== null ? Reflect.get(data, key) : undefined;
}

/** The files that block removing a task's worktree, when that is why the call failed. */
export function dirtyWorktreeFiles(error: unknown): string[] | undefined {
  const defined = definedError(error);
  if (defined?.code !== "WORKTREE_DIRTY") return undefined;
  const files = field(defined.data, "files");
  return Array.isArray(files) ? files.map(String) : [];
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
      case "ALREADY_RUNNING":
        return "This session is already running.";
      case "AGENT_NOT_FOUND":
        return `${String(field(data, "command"))} was not found on the server's PATH.`;
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
    }
  }
  return error instanceof Error ? error.message : String(error);
}
