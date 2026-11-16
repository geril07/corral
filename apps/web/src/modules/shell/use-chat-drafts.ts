import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { DRAFT_WRITE_DELAY } from "./use-task-drafts.ts";

const CHAT_DRAFT_PREFIX = "corral.chat-draft.";

function readDraft(sessionId: string): { value: string; readable: boolean } {
  try {
    return {
      value: window.localStorage.getItem(`${CHAT_DRAFT_PREFIX}${sessionId}`) ?? "",
      readable: true,
    };
  } catch {
    return { value: "", readable: false };
  }
}

/** Device-local chat drafts; only edited sessions are written, and unload flushes pending edits. */
export function useChatDrafts() {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(() => new Map());
  const draftsRef = useRef(drafts);
  const dirty = useRef(new Map<string, string>());
  const unreadable = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [storageFailed, setStorageFailed] = useState(false);

  const write = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    let failed = false;
    for (const [id, value] of dirty.current) {
      if (unreadable.current.has(id)) {
        failed = true;
        continue;
      }
      try {
        if (value === "") window.localStorage.removeItem(`${CHAT_DRAFT_PREFIX}${id}`);
        else window.localStorage.setItem(`${CHAT_DRAFT_PREFIX}${id}`, value);
        dirty.current.delete(id);
      } catch {
        failed = true;
      }
    }
    setStorageFailed(failed);
  }, []);

  const change = useCallback(
    (id: string, update: SetStateAction<string>) => {
      let current = draftsRef.current.get(id);
      if (current === undefined) {
        const stored = readDraft(id);
        current = stored.value;
        if (!stored.readable) unreadable.current.add(id);
      }
      const next = typeof update === "function" ? update(current) : update;
      if (next === current) return;
      const values = new Map(draftsRef.current);
      values.set(id, next);
      draftsRef.current = values;
      setDrafts(values);
      dirty.current.set(id, next);
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = setTimeout(write, DRAFT_WRITE_DELAY);
    },
    [write],
  );

  useEffect(() => {
    const flush = () => {
      if (dirty.current.size > 0) write();
    };
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [write]);

  return {
    get: (id: string) => drafts.get(id) ?? readDraft(id).value,
    change,
    storageFailed,
  };
}
