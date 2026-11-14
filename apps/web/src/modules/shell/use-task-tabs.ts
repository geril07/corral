import type { Session, Task } from "@corral/protocol/rpc";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  defaultLayout,
  parseLayout,
  reconcileLayout,
  serializeLayout,
  TASK_TAB_STORAGE_PREFIX,
  type TaskTabLayout,
} from "./task-tabs.ts";

export const COMPANION_MIN_WIDTH = 320;
export const COMPANION_DEFAULT_WIDTH = 600;
/** The main pane keeps this much room before the companion group grows into it. */
export const MAIN_MIN_WIDTH = 560;
const COMPANION_MAX_WIDTH = 900;
const COMPANION_WIDTH_KEY = "corral.companion-width";

function readLayout(taskId: string): TaskTabLayout | undefined {
  try {
    return parseLayout(window.localStorage.getItem(`${TASK_TAB_STORAGE_PREFIX}${taskId}`));
  } catch {
    return undefined;
  }
}

function storeLayout(taskId: string, layout: TaskTabLayout): void {
  try {
    window.localStorage.setItem(`${TASK_TAB_STORAGE_PREFIX}${taskId}`, serializeLayout(layout));
  } catch {
    // A device preference that cannot be kept must not break the workspace.
  }
}

function readCompanionWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(COMPANION_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= COMPANION_MIN_WIDTH && stored <= COMPANION_MAX_WIDTH)
      return stored;
  } catch {
    // Storage can be unavailable; the reference default still applies.
  }
  return COMPANION_DEFAULT_WIDTH;
}

/**
 * One task's device-local working-area layout. A task never opened here starts from the default
 * (primary first); every later change is written for that task only. The server owns no layout.
 */
export function useTaskTabLayout(task: Task | undefined, sessions: readonly Session[]) {
  const [layouts, setLayouts] = useState<ReadonlyMap<string, TaskTabLayout>>(() => new Map());
  const taskKey = useMemo(
    () =>
      task === undefined ? undefined : { id: task.id, primarySessionId: task.primarySessionId },
    [task?.id, task?.primarySessionId],
  );
  const sessionsRef = useRef(sessions);
  const taskRef = useRef(taskKey);
  useLayoutEffect(() => {
    sessionsRef.current = sessions;
    taskRef.current = taskKey;
  }, [sessions, taskKey]);

  // A session's status updates on every streamed delta; only a change in the set of ids can
  // change the layout, so keep the reconciled object and the window listener identity stable.
  const sessionKey = useMemo(() => {
    if (taskKey === undefined) return "";
    return sessions
      .filter((session) => session.taskId === taskKey.id)
      .map((session) => session.id)
      .join("|");
  }, [sessions, taskKey?.id]);
  const layoutSessions = useMemo(
    () =>
      taskKey === undefined ? [] : sessions.filter((session) => session.taskId === taskKey.id),
    [sessionKey],
  );
  const base = useMemo(
    () => (taskKey === undefined ? undefined : (layouts.get(taskKey.id) ?? readLayout(taskKey.id))),
    [layouts, taskKey?.id],
  );
  const layout = useMemo(
    () => (taskKey === undefined ? undefined : reconcileLayout(base, taskKey, layoutSessions)),
    [base, taskKey, layoutSessions],
  );

  useEffect(() => {
    const id = taskKey?.id;
    if (id === undefined) return undefined;
    const key = `${TASK_TAB_STORAGE_PREFIX}${id}`;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key) return;
      const parsed = parseLayout(event.newValue);
      if (parsed === undefined) return;
      setLayouts((previous) => {
        const map = new Map(previous);
        map.set(id, parsed);
        return map;
      });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [taskKey?.id]);

  /**
   * Applies a change to one named task's layout. Async work (a close waits for its session to
   * stop) keeps the task that owned the action, so switching tasks meanwhile cannot write the
   * change onto the task now on screen.
   */
  const changeFor = useCallback(
    (
      target: Pick<Task, "id" | "primarySessionId">,
      update: (current: TaskTabLayout) => TaskTabLayout,
    ) => {
      setLayouts((previous) => {
        const targetSessions = sessionsRef.current.filter(
          (session) => session.taskId === target.id,
        );
        const storedBase =
          readLayout(target.id) ?? previous.get(target.id) ?? defaultLayout(target, targetSessions);
        const current = reconcileLayout(storedBase, target, targetSessions);
        const next = update(current);
        if (next === current) return previous;
        storeLayout(target.id, next);
        const map = new Map(previous);
        map.set(target.id, next);
        return map;
      });
    },
    [],
  );

  const change = useCallback(
    (update: (current: TaskTabLayout) => TaskTabLayout) => {
      const currentTask = taskRef.current;
      if (currentTask === undefined) return;
      changeFor(currentTask, update);
    },
    [changeFor],
  );

  return { layout, change, changeFor };
}

/** The companion group's device-local preferred width; the pane clamps it to the room it has. */
export function useCompanionWidth() {
  const [width, setWidth] = useState(readCompanionWidth);
  const set = useCallback((next: number) => {
    const value = Math.round(Math.min(COMPANION_MAX_WIDTH, Math.max(COMPANION_MIN_WIDTH, next)));
    setWidth(value);
    try {
      window.localStorage.setItem(COMPANION_WIDTH_KEY, String(value));
    } catch {
      // See above: a preference that cannot be kept is not a workspace failure.
    }
  }, []);
  return { width, setWidth: set };
}

/**
 * The width range the companion actually has. At the 1024 floor with the sidebar hidden both
 * minimums hold (560 + 320 + the 8 px inset); with the sidebar open the main pane gives up part of
 * its minimum rather than let the companion become an unusable sliver.
 */
export function companionRange(available: number): { min: number; max: number } {
  if (available <= 0) return { min: COMPANION_MIN_WIDTH, max: COMPANION_DEFAULT_WIDTH };
  const max = Math.min(available, Math.max(COMPANION_MIN_WIDTH, available - MAIN_MIN_WIDTH));
  return { min: Math.min(COMPANION_MIN_WIDTH, max), max };
}

/** The width the companion actually gets, inside {@link companionRange}. */
export function companionWidthFor(preferred: number, available: number): number {
  const { min, max } = companionRange(available);
  return Math.round(Math.max(min, Math.min(preferred, max)));
}
