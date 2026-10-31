import { stringifySearchWith } from "@tanstack/react-router";

/**
 * Hash history appends the document query to the hash search, so the desktop shell's
 * `?server=<ws url>` would otherwise become part of the route's last search value. The document
 * query belongs to bootstrap, not to the route.
 *
 * Route ids are opaque strings. TanStack's default parser also turns numeric-looking values into
 * numbers, so a 12-digit hex id such as `123456789012` would fail the string search schema.
 */
export function parseRouteSearch(search: string, documentSearch: string): Record<string, unknown> {
  const query = documentSearch.startsWith("?") ? documentSearch.slice(1) : documentSearch;
  const suffix = query === "" ? "" : `?${query}`;
  const routeSearch =
    suffix !== "" && search.endsWith(suffix) ? search.slice(0, -suffix.length) : search;

  const params = new URLSearchParams(
    routeSearch.startsWith("?") ? routeSearch.slice(1) : routeSearch,
  );
  const parsed: Record<string, string | string[]> = {};
  for (const [key, value] of params) {
    const unwrapped = unwrapLegacyString(value);
    const previous = parsed[key];
    parsed[key] =
      previous === undefined
        ? unwrapped
        : Array.isArray(previous)
          ? [...previous, unwrapped]
          : [previous, unwrapped];
  }
  return parsed;
}

/** The default stringifier quoted numeric-looking strings; old links still carry that form. */
function unwrapLegacyString(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

export const stringifyRouteSearch = stringifySearchWith(String);
