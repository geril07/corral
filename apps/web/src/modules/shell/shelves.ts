import { useCallback, useState } from "react";

/**
 * A sidebar shelf is collapsed until the user opens it; the one device-local fact it owns. The
 * stored object is shared with the prior sidebar, whose state was `{expanded, page}`: each shelf
 * reads and writes its own bit by merging, so the other's survives. A value an older build wrote
 * is read defensively.
 */
function isStoredRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStored(key: string): Record<string, unknown> {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null");
    return isStoredRecord(saved) ? saved : {};
  } catch {
    // Storage can be unavailable (a sandboxed or `file:` origin); the collapsed default applies.
    return {};
  }
}

function store(key: string, expanded: boolean): void {
  try {
    window.localStorage.setItem(key, JSON.stringify({ ...readStored(key), expanded }));
  } catch {
    // A preference that cannot be kept must not break the sidebar.
  }
}

export interface Shelf {
  expanded: boolean;
  toggle: () => void;
}

/** Only a user action writes the bit, never the list's contents. */
function useShelf(key: string): Shelf {
  const [expanded, setExpanded] = useState(() => readStored(key).expanded === true);
  const toggle = useCallback(
    () =>
      setExpanded((current) => {
        store(key, !current);
        return !current;
      }),
    [key],
  );
  return { expanded, toggle };
}

const SETTLED_SHELF_KEY = "corral.sidebar-shelf";

export function useSettledShelf(): Shelf {
  return useShelf(SETTLED_SHELF_KEY);
}

const SNOOZED_SHELF_KEY = "corral.sidebar-snoozed-shelf";

export function useSnoozedShelf(): Shelf {
  return useShelf(SNOOZED_SHELF_KEY);
}
