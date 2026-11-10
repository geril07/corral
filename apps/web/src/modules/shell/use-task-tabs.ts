import type { Session, Task } from "@corral/protocol/rpc";
import { useCallback, useRef, useState } from "react";
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
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const stored = task === undefined ? undefined : (layouts.get(task.id) ?? readLayout(task.id));
  const layout = task === undefined ? undefined : reconcileLayout(stored, task, sessions);

  const change = useCallback(
    (update: (current: TaskTabLayout) => TaskTabLayout) => {
      if (task === undefined) return;
      setLayouts((previous) => {
        const base =
          previous.get(task.id) ?? readLayout(task.id) ?? defaultLayout(task, sessionsRef.current);
        const current = reconcileLayout(base, task, sessionsRef.current);
        const next = update(current);
        if (next === current) return previous;
        storeLayout(task.id, next);
        const map = new Map(previous);
        map.set(task.id, next);
        return map;
      });
    },
    [task],
  );

  return { layout, change };
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
