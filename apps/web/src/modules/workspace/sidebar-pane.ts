import { useCallback, useEffect, useState } from "react";

/** Sidebar sizing and visibility per device (`layout.md`, **Shell**). */
export const SIDEBAR_MIN_WIDTH = 208;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 264;
/** A narrower window starts with a narrower sidebar instead of leaving the main area nothing. */
export const SIDEBAR_NARROW_WIDTH = 232;
export const SIDEBAR_NARROW_BELOW = 1180;
/** The main area never gives up more than this, whatever the edge or a stored width asks for. */
export const MAIN_AREA_MIN_WIDTH = 640;

const WIDTH_KEY = "corral.sidebar-width";
const HIDDEN_KEY = "corral.sidebar-hidden";

/** The widest sidebar this window may have: the static maximum or the main area's 640 px, whichever wins. */
export function maxSidebarWidth(windowWidth: number): number {
  return Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, windowWidth - MAIN_AREA_MIN_WIDTH),
  );
}

/** Keeps a width inside 208–420 px and inside what the window can spare for the main area. */
export function clampSidebarWidth(width: number, windowWidth = window.innerWidth): number {
  return Math.round(Math.min(maxSidebarWidth(windowWidth), Math.max(SIDEBAR_MIN_WIDTH, width)));
}

/** The width a device starts with, before the user has dragged the edge. */
export function defaultSidebarWidth(windowWidth: number): number {
  return windowWidth < SIDEBAR_NARROW_BELOW ? SIDEBAR_NARROW_WIDTH : SIDEBAR_DEFAULT_WIDTH;
}

function readWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(WIDTH_KEY));
    // A stored width outside the slider's range is corrupt or from another layout: fall back to
    // the device default rather than silently changing what the user last chose to something else.
    if (Number.isFinite(stored) && stored >= SIDEBAR_MIN_WIDTH && stored <= SIDEBAR_MAX_WIDTH) {
      return clampSidebarWidth(stored);
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
  /** The widest the sidebar may be in this window; follows window resizes. */
  maxWidth: number;
  setWidth: (width: number) => void;
  resetWidth: () => void;
  toggle: () => void;
}

/**
 * The sidebar's width and visibility, the resize handle's setters and `prefix \`. Only a user
 * action writes the device preference: mounting must not freeze today's window-dependent default
 * into storage, or the Shell defaults would be one-shot per profile.
 */
export function useSidebarPane(): SidebarPane {
  const [width, setStoredWidth] = useState(readWidth);
  const [hidden, setHidden] = useState(readHidden);
  const [maxWidth, setMaxWidth] = useState(() => maxSidebarWidth(window.innerWidth));

  // A window that shrinks under a width the user chose must not squeeze the main area below its
  // reserve: re-clamp, keep the size if it still fits, and republish the maximum. Nothing here
  // writes the preference; only a user action does.
  useEffect(() => {
    const onResize = () => {
      setMaxWidth(maxSidebarWidth(window.innerWidth));
      setStoredWidth((current) => clampSidebarWidth(current));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const setWidth = useCallback((next: number) => {
    const value = clampSidebarWidth(next);
    setStoredWidth(value);
    store(WIDTH_KEY, String(value));
  }, []);
  const resetWidth = useCallback(() => {
    const value = defaultSidebarWidth(window.innerWidth);
    setStoredWidth(value);
    store(WIDTH_KEY, String(value));
  }, []);
  const toggle = useCallback(() => {
    const next = !hidden;
    setHidden(next);
    store(HIDDEN_KEY, String(next));
  }, [hidden]);
  return { width, hidden, maxWidth, setWidth, resetWidth, toggle };
}
