import type { SidebarMode } from "@corral/client/workspace-tree";
import { useCallback, useEffect, useState } from "react";

/** Device preference: this browser remembers the mode it was left in; another device keeps its own. */
const STORAGE_KEY = "corral.sidebar-mode";

export const DEFAULT_SIDEBAR_MODE: SidebarMode = "flat";

function read(): SidebarMode {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "project"
      ? "project"
      : DEFAULT_SIDEBAR_MODE;
  } catch {
    // Storage can be unavailable (a sandboxed or file: origin); the mode still toggles.
    return DEFAULT_SIDEBAR_MODE;
  }
}

function write(mode: SidebarMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Same as above: a preference that cannot be kept must not break the sidebar.
  }
}

/** The sidebar's mode and the toggle the `sidebar-mode` action and the palette run. */
export function useSidebarMode(): [SidebarMode, () => void] {
  const [mode, setMode] = useState<SidebarMode>(read);

  useEffect(() => write(mode), [mode]);

  const toggle = useCallback(
    () => setMode((current) => (current === "flat" ? "project" : "flat")),
    [],
  );
  return [mode, toggle];
}
