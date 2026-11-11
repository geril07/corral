import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseDrafts,
  serializeDrafts,
  TASK_DRAFT_STORAGE_KEY,
  type TaskDraft,
} from "./task-drafts.ts";

/** Both references debounce composer persistence; T3 writes after 300 ms and flushes on unload. */
export const DRAFT_WRITE_DELAY = 300;

function readDrafts(): TaskDraft[] {
  try {
    return parseDrafts(window.localStorage.getItem(TASK_DRAFT_STORAGE_KEY)) ?? [];
  } catch {
    // Storage can be unavailable; the drafts still work for this page.
    return [];
  }
}

/**
 * The open drafts on this device (`docs/layout.md`, **New task view**). The document is written as
 * a whole, 300 ms after the last edit and before the page unloads, so typing survives a reload
 * without a write per keystroke.
 */
export function useTaskDrafts() {
  const [drafts, setDrafts] = useState<readonly TaskDraft[]>(readDrafts);
  const draftsRef = useRef<readonly TaskDraft[]>(drafts);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const write = useCallback(() => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    try {
      window.localStorage.setItem(TASK_DRAFT_STORAGE_KEY, serializeDrafts(draftsRef.current));
    } catch {
      // A device preference that cannot be kept must not break the composer.
    }
  }, []);
  const change = useCallback(
    (update: (current: readonly TaskDraft[]) => readonly TaskDraft[]) => {
      const next = update(draftsRef.current);
      if (next === draftsRef.current) return;
      draftsRef.current = next;
      setDrafts(next);
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = setTimeout(write, DRAFT_WRITE_DELAY);
    },
    [write],
  );
  useEffect(() => {
    const flush = () => write();
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [write]);
  // The ref is the same list the state holds and changes before React commits, so a create's
  // completion reads the draft of this moment, not the one of an older render.
  return { drafts, draftsRef, change };
}
