export interface PageLocation {
  search: string;
  protocol: string;
  host: string;
}

/**
 * The desktop app loads the page with `?server=<ws url>`. A page the server itself serves
 * (browser mode, later) has no such parameter and talks to its own origin.
 */
export function resolveServerUrl(location: PageLocation): string {
  const given = new URLSearchParams(location.search).get("server");
  if (given !== null) {
    if (!/^wss?:\/\/[^/]/.test(given))
      throw new Error(`server URL must be ws:// or wss://: ${given}`);
    return given;
  }
  if (!location.host) throw new Error("no ?server=<ws url> and the page has no origin to use");
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
}
