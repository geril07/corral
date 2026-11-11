import type { LaunchSelection } from "../sessions/index.ts";

/**
 * A draft the production shell keeps outside the composer. The project can be `null`: that is a
 * scratch task, which the server owns and which has no Git workspace. Prompt and focus survive a
 * project/No project switch, a cancelled picker and a failed create because this value lives in
 * the workspace, not in a form that unmounts (`docs/ux.md`, **Task entry**).
 */
export interface TaskComposerDraft {
  /** `null` means No project: a scratch task under the server's data directory. */
  projectId: string | null;
  prompt: string;
  /** The named instance/model the user picked; `undefined` follows the project's settings. */
  agent: LaunchSelection | undefined;
  /** The workspace the user picked; `undefined` follows the project's settings. */
  workspaceKey: string | undefined;
  /**
   * The branch a new worktree starts from; `undefined` follows the project's default base. It
   * belongs to the project, so switching projects drops it.
   */
  baseBranch: string | undefined;
}

export function emptyTaskComposerDraft(projectId: string | null): TaskComposerDraft {
  return {
    projectId,
    prompt: "",
    agent: undefined,
    workspaceKey: undefined,
    baseBranch: undefined,
  };
}
