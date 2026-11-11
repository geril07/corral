import { useCallback, useState } from "react";

/**
 * The Settled shelf is collapsed until the user opens it (`design.md`, **Domain model** — Task).
 * The same key the prior sidebar used, so the one shelf keeps one device preference; only the
 * expanded bit is read and written here, and a value an older build wrote is read defensively.
 */
const SHELF_KEY = "corral.sidebar-shelf";

function readExpanded(): boolean {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(SHELF_KEY) ?? "null");
    if (saved === null || typeof saved !== "object") return false;
    return (saved as { expanded?: unknown }).expanded === true;
  } catch {
    // Storage can be unavailable (a sandboxed or `file:` origin); the collapsed default applies.
    return false;
  }
}

function store(expanded: boolean): void {
  try {
    window.localStorage.setItem(SHELF_KEY, JSON.stringify({ expanded }));
  } catch {
    // A preference that cannot be kept must not break the sidebar.
  }
}

export interface SettledShelf {
  expanded: boolean;
  toggle: () => void;
}

/** The shelf's one device-local fact. Only a user action writes it. */
export function useSettledShelf(): SettledShelf {
  const [expanded, setExpanded] = useState(readExpanded);
  const toggle = useCallback(
    () =>
      setExpanded((current) => {
        store(!current);
        return !current;
      }),
    [],
  );
  return { expanded, toggle };
}
