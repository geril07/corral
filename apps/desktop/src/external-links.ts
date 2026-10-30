/**
 * Only ordinary web links may leave the app. The OS browser is the container for them; the
 * capability-bearing window never loads them and never hands them a preload bridge.
 */
export function externalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Navigation the local app itself may perform: the bundle file it was loaded from (any query or
 * hash on that file), or the dev server origin in browser dev mode. Everything else is external.
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
