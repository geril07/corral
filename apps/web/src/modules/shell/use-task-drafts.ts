import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseDrafts,
  serializeDrafts,
  TASK_DRAFT_STORAGE_KEY,
  type TaskDraft,
} from "./task-drafts.ts";

/** Both references debounce composer persistence; T3 writes after 300 ms and flushes on unload. */
export const DRAFT_WRITE_DELAY = 300;

/**
 * T3's sentence for a draft the device would not keep, verbatim from
 * `apps/mobile/src/features/pull-requests/usePullRequestReviewDraft.ts`.
 */
export const DRAFT_STORAGE_NOTICE =
  "Drafts are kept in this session, but could not be saved on this device.";

interface MountedDrafts {
  drafts: TaskDraft[];
  /** False when the record could not be read, so a write would replace text this page never saw. */
  readable: boolean;
}

function readDrafts(): MountedDrafts {
  try {
    return {
      drafts: parseDrafts(window.localStorage.getItem(TASK_DRAFT_STORAGE_KEY)) ?? [],
      readable: true,
    };
  } catch {
    // Storage can be unavailable; the drafts still work for this page.
    return { drafts: [], readable: false };
  }
}

/**
 * The open drafts on this device (`docs/layout.md`, **New task view**). The document is written as
 * a whole, 300 ms after the last edit and before the page unloads, so typing survives a reload
 * without a write per keystroke. A window that changed nothing it stores writes nothing on close,
 * so it cannot erase what another window typed into the same record.
 */
export function useTaskDrafts() {
  const [mounted] = useState(readDrafts);
  const [drafts, setDrafts] = useState<readonly TaskDraft[]>(mounted.drafts);
  const [storageFailed, setStorageFailed] = useState(false);
  const draftsRef = useRef<readonly TaskDraft[]>(drafts);
  const readable = useRef(mounted.readable);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const write = useCallback(() => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    dirty.current = false;
    // A page that could not read the record never replaces it: the text it never saw would be
    // lost, and the record may be perfectly readable from another window.
    if (!readable.current) return;
    try {
      window.localStorage.setItem(TASK_DRAFT_STORAGE_KEY, serializeDrafts(draftsRef.current));
      setStorageFailed(false);
    } catch {
      // A device preference that cannot be kept must not break the composer; the shell says so
      // once through its notice instead.
      setStorageFailed(true);
    }
  }, []);
  const change = useCallback(
    (update: (current: readonly TaskDraft[]) => readonly TaskDraft[]) => {
      const current = draftsRef.current;
      const next = update(current);
      if (next === current) return;
      draftsRef.current = next;
      setDrafts(next);
      // Opening an empty draft, or closing one back to nothing, leaves the stored record as it
      // was; scheduling a write for it would let an idle window overwrite another window's text.
      if (serializeDrafts(next) === serializeDrafts(current)) return;
      dirty.current = true;
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = setTimeout(write, DRAFT_WRITE_DELAY);
    },
    [write],
  );
  useEffect(() => {
    // Only an edit is flushed: an idle window's snapshot is stale, and writing it would delete
    // another window's draft.
    const flush = () => {
      if (!dirty.current) return;
      write();
    };
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
  return { drafts, draftsRef, change, storageFailed };
}
