import { useCallback, useEffect, useState } from "react";

/** Corral's proposed sidebar geometry for the first visual slice (`#258`, §4.1). */
export const VISUAL_SIDEBAR_MIN_WIDTH = 280;
export const VISUAL_SIDEBAR_MAX_WIDTH = 640;
export const VISUAL_SIDEBAR_DEFAULT_WIDTH = 320;
/** The main surface never gives up more than this, so a narrow window cannot invert the layout. */
export const VISUAL_MAIN_MIN_WIDTH = 360;

const WIDTH_KEY = "corral.visual-sidebar-width";
const HIDDEN_KEY = "corral.visual-sidebar-hidden";

/** The static range plus what this window can spare for the main surface. */
export function maxVisualSidebarWidth(windowWidth: number): number {
  return Math.max(
    VISUAL_SIDEBAR_MIN_WIDTH,
    Math.min(VISUAL_SIDEBAR_MAX_WIDTH, windowWidth - VISUAL_MAIN_MIN_WIDTH),
  );
}

export function clampVisualSidebarWidth(width: number, windowWidth = window.innerWidth): number {
  return Math.round(
    Math.min(maxVisualSidebarWidth(windowWidth), Math.max(VISUAL_SIDEBAR_MIN_WIDTH, width)),
  );
}

function readWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(WIDTH_KEY));
    if (
      Number.isFinite(stored) &&
      stored >= VISUAL_SIDEBAR_MIN_WIDTH &&
      stored <= VISUAL_SIDEBAR_MAX_WIDTH
    ) {
      return stored;
    }
  } catch {
    // Storage can be unavailable; the proposed default still applies.
  }
  return VISUAL_SIDEBAR_DEFAULT_WIDTH;
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

export interface VisualSidebarPane {
  width: number;
  hidden: boolean;
  resizing: boolean;
  maxWidth: number;
  setWidth: (width: number) => void;
  beginResize: () => void;
  endResize: () => void;
  toggle: () => void;
}

/** The sidebar's device-local width and visibility. Only a user action writes the preference. */
export function useVisualSidebarPane(): VisualSidebarPane {
  const [preference, setPreference] = useState(readWidth);
  const [hidden, setHidden] = useState(readHidden);
  const [resizing, setResizing] = useState(false);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const maxWidth = maxVisualSidebarWidth(windowWidth);
  const width = Math.min(preference, maxWidth);

  const setWidth = useCallback((next: number) => {
    const value = Math.round(
      Math.min(VISUAL_SIDEBAR_MAX_WIDTH, Math.max(VISUAL_SIDEBAR_MIN_WIDTH, next)),
    );
    setPreference(value);
    store(WIDTH_KEY, String(value));
  }, []);
  const toggle = useCallback(() => {
    setHidden((current) => {
      store(HIDDEN_KEY, String(!current));
      return !current;
    });
  }, []);
  const beginResize = useCallback(() => setResizing(true), []);
  const endResize = useCallback(() => setResizing(false), []);
  return { width, hidden, resizing, maxWidth, setWidth, beginResize, endResize, toggle };
}
