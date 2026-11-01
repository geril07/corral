import type { PullRequest } from "@corral/protocol/rpc";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangesActions } from "./finish-actions.ts";
import { PULL_REQUEST_REFRESH_MS } from "./finish-actions.ts";

export interface PullRequests {
  byTask: ReadonlyMap<string, PullRequest>;
  /** Takes a request the Changes tab just created or refreshed, without another round trip. */
  remember(request: PullRequest): void;
}

/**
 * The pull requests linked to the listed tasks, for the task header's badge and the sidebar rows.
 * `changes.pullRequest` is a cheap read for a task with no link, so the whole list is asked; a task
 * with one refreshes through its CLI, on mount, on window focus and every
 * `PULL_REQUEST_REFRESH_MS`. A refusal (an older daemon has no such procedure) leaves the map as it
 * is: no badge is better than a badge that lies, and the tab itself says the action is unavailable.
 */
export function usePullRequests(
  actionsFor: (taskId: string) => ChangesActions | undefined,
  taskIds: readonly string[],
): PullRequests {
  const [byTask, setByTask] = useState<ReadonlyMap<string, PullRequest>>(new Map());
  const key = taskIds.join("\n");
  const actionsKey = taskIds.length === 0 ? "" : key;

  const remember = useCallback((request: PullRequest) => {
    setByTask((current) => {
      const next = new Map(current);
      next.set(request.taskId, request);
      return next;
    });
  }, []);

  useEffect(() => {
    let live = true;
    const ids = actionsKey === "" ? [] : actionsKey.split("\n");
    const load = (refresh: boolean) => {
      for (const id of ids) {
        const actions = actionsFor(id);
        if (actions === undefined) continue;
        void actions.pullRequest({ refresh }).then(
          (request) => {
            if (live && request !== null) remember(request);
          },
          // No link is not an error, and a server that cannot answer keeps the last known badge.
          () => undefined,
        );
      }
    };
    load(true);
    const onFocus = () => load(true);
    window.addEventListener("focus", onFocus);
    const timer = setInterval(onFocus, PULL_REQUEST_REFRESH_MS);
    return () => {
      live = false;
      window.removeEventListener("focus", onFocus);
      clearInterval(timer);
    };
    // `actionsFor` is rebuilt with the task list; the key is what actually changes.
  }, [actionsKey, remember]);

  return useMemo(() => ({ byTask, remember }), [byTask, remember]);
}
