/** The desktop preload bridge; a browser page has none and cannot re-read the endpoint file. */
export function isDesktopHost(): boolean {
  return typeof window !== "undefined" && window.corral !== undefined;
}
