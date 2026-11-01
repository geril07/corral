import { useCallback, useEffect, useState } from "react";

/** Sidebar sizing and visibility per device (`layout.md`, **Shell**). */
export const SIDEBAR_MIN_WIDTH = 208;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 264;
/** A narrower window starts with a narrower sidebar instead of leaving the main area nothing. */
export const SIDEBAR_NARROW_WIDTH = 232;
export const SIDEBAR_NARROW_BELOW = 1180;

const WIDTH_KEY = "corral.sidebar-width";
const HIDDEN_KEY = "corral.sidebar-hidden";

export function clampSidebarWidth(width: number): number {
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

/** The width a device starts with, before the user has dragged the edge. */
export function defaultSidebarWidth(windowWidth: number): number {
  return windowWidth < SIDEBAR_NARROW_BELOW ? SIDEBAR_NARROW_WIDTH : SIDEBAR_DEFAULT_WIDTH;
}

function readWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= SIDEBAR_MIN_WIDTH && stored <= SIDEBAR_MAX_WIDTH) {
      return stored;
    }
  } catch {
    // Storage can be unavailable (a sandboxed or file: origin); the default still applies.
  }
  return defaultSidebarWidth(window.innerWidth);
}

function readHidden(): boolean {
  try {
    return window.localStorage.getItem(HIDDEN_KEY) === "true";
  } catch {
    return false;
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A preference that cannot be kept must not break the shell.
  }
}

export interface SidebarPane {
  width: number;
  hidden: boolean;
  setWidth: (width: number) => void;
  resetWidth: () => void;
  toggle: () => void;
}

/** The sidebar's width and visibility, the resize handle's setters and `prefix \`. */
export function useSidebarPane(): SidebarPane {
  const [width, setStoredWidth] = useState(readWidth);
  const [hidden, setHidden] = useState(readHidden);

  useEffect(() => store(WIDTH_KEY, String(width)), [width]);
  useEffect(() => store(HIDDEN_KEY, String(hidden)), [hidden]);

  const setWidth = useCallback((next: number) => setStoredWidth(clampSidebarWidth(next)), []);
  const resetWidth = useCallback(() => setStoredWidth(defaultSidebarWidth(window.innerWidth)), []);
  const toggle = useCallback(() => setHidden((current) => !current), []);
  return { width, hidden, setWidth, resetWidth, toggle };
}
