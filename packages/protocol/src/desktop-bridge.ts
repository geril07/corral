import type { ServerTarget } from "./server-target.ts";

/** IPC channel through which the desktop shell hands the page its server endpoint. */
export const DESKTOP_SERVER_CHANNEL = "corral:server";

/**
 * The narrow bridge the desktop preload exposes to the app page. The endpoint file is the
 * only source: the page never reads it, and the token never enters the page URL.
 */
export interface DesktopBridge {
  /** `null` when the app has no usable server (the error page is shown instead). */
  server(): Promise<ServerTarget | null>;
}
