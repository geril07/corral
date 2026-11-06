import { useCallback, useEffect, useState } from "react";

/**
 * The sidebar's device state: the project groups the user closed and the Settled shelf's page
 * (`layout.md`, **Sidebar**). Read defensively like the sidebar mode: storage can be unavailable
 * (a sandboxed or `file:` origin) or hold a value an older build wrote, and neither may break the
 * list.
 */
const COLLAPSED_PROJECTS_KEY = "corral.sidebar-collapsed";
const SHELF_KEY = "corral.sidebar-shelf";

/** The active list keeps this many rows when the shelf is open; the shelf shrinks first. */
export const SHELF_MIN_ACTIVE_ROWS = 4;

export interface ShelfState {
  /** The user opened the shelf; a shelf the selection opened lives beside this, not in storage. */
  expanded: boolean;
  /** How many measured pages the user revealed with Show more. */
  page: number;
}

export const DEFAULT_SHELF_STATE: ShelfState = { expanded: false, page: 1 };

/**
 * One page is the whole rows the shelf's measured box fits; a box smaller than a row still holds
 * one (`layout.md`, **Sidebar**). The box is measured, not a fixed row count: the interface scale
 * and the window decide it.
 */
export function shelfPageSize(boxHeight: number, rowHeight: number): number {
  if (!Number.isFinite(boxHeight) || !Number.isFinite(rowHeight) || rowHeight <= 0) return 1;
  return Math.max(1, Math.floor(boxHeight / rowHeight));
}

/**
 * How many rows the shelf mounts. The user's pages are the floor; a selected row beyond them
 * mounts its own page and at most one page beyond it, so an old selection is reachable without
 * mounting the whole history.
 */
export function shelfMountedRows(
  total: number,
  pageSize: number,
  pages: number,
  currentIndex: number,
): number {
  const size = Math.max(1, pageSize);
  const revealed = Math.max(1, pages) * size;
  const forCurrent =
    currentIndex < 0 || currentIndex < revealed
      ? revealed
      : (Math.floor(currentIndex / size) + 2) * size;
  return Math.min(total, Math.max(revealed, forCurrent));
}

function readCollapsedProjects(): ReadonlySet<string> {
  try {
    const saved: unknown = JSON.parse(
      window.localStorage.getItem(COLLAPSED_PROJECTS_KEY) ?? "null",
    );
    if (!Array.isArray(saved)) return new Set();
    return new Set(saved.filter((value): value is string => typeof value === "string"));
  } catch {
    // Same as the mode: a preference that cannot be read must not break the sidebar.
    return new Set();
  }
}

function readShelfState(): ShelfState {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(SHELF_KEY) ?? "null");
    if (saved === null || typeof saved !== "object") return DEFAULT_SHELF_STATE;
    const { expanded, page } = saved as { expanded?: unknown; page?: unknown };
    return {
      expanded: typeof expanded === "boolean" ? expanded : DEFAULT_SHELF_STATE.expanded,
      page:
        typeof page === "number" && Number.isInteger(page) && page >= 1
          ? page
          : DEFAULT_SHELF_STATE.page,
    };
  } catch {
    return DEFAULT_SHELF_STATE;
  }
}

function store(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A preference that cannot be kept must not break the sidebar.
  }
}

export interface SidebarDevice {
  closedProjects: ReadonlySet<string>;
  toggleProject: (key: string) => void;
  openProject: (key: string) => void;
  shelf: ShelfState;
  setShelf: (update: (current: ShelfState) => ShelfState) => void;
}

/**
 * The sidebar's device state in one hook: a group is keyed by the project, or by the composer's
 * open while a composer shows that group; the shelf keeps its expanded state and page. Both are
 * written on change, so hiding the sidebar with `prefix \` and reloading the page keep them.
 */
export function useSidebarDevice(): SidebarDevice {
  const [closedProjects, setClosedProjects] = useState(readCollapsedProjects);
  const [shelf, setShelfState] = useState(readShelfState);

  useEffect(() => store(COLLAPSED_PROJECTS_KEY, [...closedProjects]), [closedProjects]);
  useEffect(() => store(SHELF_KEY, shelf), [shelf]);

  const toggleProject = useCallback(
    (key: string) =>
      setClosedProjects((closed) => {
        const next = new Set(closed);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );
  const openProject = useCallback(
    (key: string) =>
      setClosedProjects((closed) => {
        if (!closed.has(key)) return closed;
        const next = new Set(closed);
        next.delete(key);
        return next;
      }),
    [],
  );
  const setShelf = useCallback(
    (update: (current: ShelfState) => ShelfState) => setShelfState((current) => update(current)),
    [],
  );
  return { closedProjects, toggleProject, openProject, shelf, setShelf };
}
