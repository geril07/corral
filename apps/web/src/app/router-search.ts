import { defaultParseSearch } from "@tanstack/react-router";

/**
 * Hash history appends the document query to the hash search, so the desktop shell's
 * `?server=<ws url>` would otherwise become part of the route's last search value. The document
 * query belongs to bootstrap, not to the route.
 */
export function parseRouteSearch(search: string, documentSearch: string): Record<string, unknown> {
  const query = documentSearch.startsWith("?") ? documentSearch.slice(1) : documentSearch;
  const suffix = query === "" ? "" : `?${query}`;
  const routeSearch =
    suffix !== "" && search.endsWith(suffix) ? search.slice(0, -suffix.length) : search;
  return defaultParseSearch(routeSearch);
}
