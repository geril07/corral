import { useCallback, useState } from "react";

/**
 * The Settled shelf is collapsed until the user opens it (`design.md`, **Domain model** — Task).
 * The same key the prior sidebar used, whose state is `{expanded, page}`: the expanded bit is read
 * here and written by merging into the stored object, so the prior shelf's page survives. A value
 * an older build wrote is read defensively.
 */
const SHELF_KEY = "corral.sidebar-shelf";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStored(): Record<string, unknown> {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(SHELF_KEY) ?? "null");
    return isRecord(saved) ? saved : {};
  } catch {
    // Storage can be unavailable (a sandboxed or `file:` origin); the collapsed default applies.
    return {};
  }
}

function readExpanded(): boolean {
  return readStored().expanded === true;
}

function store(expanded: boolean): void {
  try {
    window.localStorage.setItem(SHELF_KEY, JSON.stringify({ ...readStored(), expanded }));
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
