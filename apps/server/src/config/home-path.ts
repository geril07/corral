import { resolve } from "node:path";

/**
 * The absolute path `path` names, with a leading `~` replaced by the server's `home` and
 * separators collapsed by the platform's `resolve`. The home is the server's own, never the
 * client's, so a path input means the same directory to every client.
 */
export function expandHomePath(path: string, home: string): string {
  if (path === "~") return resolve(home);
  if (path.startsWith("~/")) return resolve(home, path.slice(1).replace(/^[/\\]+/, ""));
  return resolve(path);
}
