import type { TaskView } from "@corral/protocol/config";
import type { TaskSource } from "@corral/protocol/rpc";
import type { LaunchSelection } from "../sessions/index.ts";
import { isBranchKey } from "./new-task-defaults.ts";

/**
 * What the composer keeps while it is closed or remounted. It lives in the workspace, so a project
 * navigation (a new composer) cannot throw the user's text away; only the parts the previous
 * project owned are dropped (`movedDraft`).
 */
export interface ComposerDraft {
  /** The project the project-scoped parts - import snapshot, branch, imported prompt - belong to. */
  projectId: string;
  prompt: string;
  /** True while the prompt is the user's own text; an import only fills a prompt that is not. */
  promptTyped: boolean;
  title: string;
  source: TaskSource | undefined;
  titleOpen: boolean;
  issueOpen: boolean;
  /** The agent the user picked; `undefined` follows the project's settings. */
  agent: LaunchSelection | undefined;
  /** The workspace the user picked; `undefined` follows the project's settings. */
  workspaceKey: string | undefined;
  /** The view the user picked; `undefined` follows the project's settings. */
  viewKey: TaskView | undefined;
}

/** A draft for `projectId` with nothing typed: what a created task and a fresh app start with. */
export function emptyDraft(projectId: string): ComposerDraft {
  return {
    projectId,
    prompt: "",
    promptTyped: false,
    title: "",
    source: undefined,
    titleOpen: false,
    issueOpen: false,
    agent: undefined,
    workspaceKey: undefined,
    viewKey: undefined,
  };
}

/**
 * The draft as seen from another project. The user's own text stays (a typed prompt, the title,
 * the agent they picked), while what only the old project could vouch for goes: the issue
 * snapshot, the prompt an import filled and an existing branch. The fields the user has not
 * touched keep following the new project's settings (`undefined` keys).
 */
export function movedDraft(draft: ComposerDraft, projectId: string): ComposerDraft {
  const typed = draft.promptTyped;
  return {
    ...draft,
    projectId,
    prompt: typed ? draft.prompt : "",
    promptTyped: typed,
    source: undefined,
    workspaceKey:
      draft.workspaceKey !== undefined && isBranchKey(draft.workspaceKey)
        ? undefined
        : draft.workspaceKey,
  };
}

/** The draft for the project the composer shows now; a stale one moves first. */
export function draftForProject(draft: ComposerDraft, projectId: string): ComposerDraft {
  return draft.projectId === projectId ? draft : movedDraft(draft, projectId);
}
