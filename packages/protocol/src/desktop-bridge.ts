import type { ServerTarget } from "./server-target.ts";

/** IPC channel through which the desktop shell hands the page its server endpoint. */
export const DESKTOP_SERVER_CHANNEL = "corral:server";

/** IPC channel through which the page asks the shell to hand an ordinary web link to the OS. */
export const DESKTOP_OPEN_EXTERNAL_CHANNEL = "corral:open-external";

/**
 * The narrow bridge the desktop preload exposes to the app page. The endpoint file is the
 * only source: the page never reads it, and the token never enters the page URL.
 */
export interface DesktopBridge {
  /** `null` when the app has no usable server (the error page is shown instead). */
  server(): Promise<ServerTarget | null>;
  /**
   * Opens an ordinary http(s) link in the OS browser, never in the capability-bearing window
   * (`docs/design.md`, **Local trust boundary**). The shell validates the URL again, so a page
   * cannot hand it a `file:` or `javascript:` target.
   */
  openExternal(url: string): Promise<void>;
}
