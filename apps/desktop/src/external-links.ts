/**
 * Navigation the local app itself may perform: the bundle file it was loaded from (any query or
 * hash on that file), or the dev server origin in browser dev mode. Everything else is external,
 * and `externalUrl` (`@corral/protocol/external-url`) is the one rule for what leaves the app.
 */
export function isAppNavigation(currentUrl: string, target: string): boolean {
  try {
    const current = new URL(currentUrl);
    const next = new URL(target);
    if (current.protocol === "file:") {
      return next.protocol === "file:" && next.pathname === current.pathname;
    }
    return next.origin === current.origin;
  } catch {
    return false;
  }
}
