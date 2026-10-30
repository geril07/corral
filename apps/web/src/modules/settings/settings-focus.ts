import { useEffect } from "react";

/** The sidebar's settings entry; the surface is a route, so the trigger may be gone while it shows. */
export const SETTINGS_BUTTON_ID = "workspace-settings";

let pending = false;

export function requestSettingsFocus(): void {
  pending = true;
}

/** Focuses the workspace's settings entry once, after returning from the settings route. */
export function useRestoreSettingsFocus(): void {
  useEffect(() => {
    if (!pending) return;
    pending = false;
    document.getElementById(SETTINGS_BUTTON_ID)?.focus();
  }, []);
}
