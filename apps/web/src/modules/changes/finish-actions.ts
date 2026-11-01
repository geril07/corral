import type { CorralClient } from "@corral/client/corral-client";
import type {
  ChangesFinish,
  ChangesRemote,
  IssueProvider,
  PullRequest,
} from "@corral/protocol/rpc";

/**
 * What the Changes tab's staging, commit, push and pull-request controls call. The workspace builds
 * it from the connection for one task, so the view holds no RPC client (the same split ChatView
 * keeps) and a test can answer without a server.
 */
export interface ChangesActions {
  /** The branch, base, push remote and staged paths: read on mount and after every write. */
  finish(): Promise<ChangesFinish>;
  stage(input: { paths: string[] | "all"; staged: boolean }): Promise<ChangesFinish>;
  commit(message: string): Promise<{
    sha: string;
    shortSha: string;
    subject: string;
    finish: ChangesFinish;
  }>;
  push(input: { remote: ChangesRemote; branch: string }): Promise<{ finish: ChangesFinish }>;
  createPullRequest(input: {
    provider: IssueProvider;
    remote: ChangesRemote;
    branch: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<PullRequest>;
  pullRequest(input: { refresh: boolean }): Promise<PullRequest | null>;
}

/**
 * How often the task's pull-request state is refreshed while the window stays open (`layout.md`
 * does not name a rate; C6 does): on every focus of the window, and once a minute. Only a task with
 * a stored link reaches a CLI — a task without one is one database read.
 */
export const PULL_REQUEST_REFRESH_MS = 60_000;

/**
 * The actions for one task, bound to the app's connection: one object per task id, memoized by the
 * caller, because the finish bar re-reads `finish` when its actions change identity.
 */
export function createChangesActions(client: CorralClient, taskId: string): ChangesActions {
  const changes = () => client.connection.api.changes;
  return {
    finish: () => changes().finish({ id: taskId }),
    stage: (input) => changes().stage({ id: taskId, ...input }),
    commit: (message) => changes().commit({ id: taskId, message }),
    push: (input) => changes().push({ id: taskId, ...input }),
    createPullRequest: (input) => changes().createPullRequest({ id: taskId, ...input }),
    pullRequest: (input) => changes().pullRequest({ id: taskId, refresh: input.refresh }),
  };
}
