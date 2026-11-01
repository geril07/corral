import { externalUrl } from "@corral/protocol/external-url";

/** What the shell does with a bridge request; the tests pass their own. */
export interface ShellActions {
  /** Hands an ordinary web link to the OS browser (`shell.openExternal` in the app). */
  openExternal(url: string): void;
}

/**
 * One page request to open a link in the OS browser. The page has already decided not to load it
 * (`docs/design.md`, **Local trust boundary**); the shell re-checks the scheme, so a compromised
 * renderer cannot hand it `file:` or `javascript:`.
 */
export function openExternalRequest(value: unknown, actions: ShellActions): void {
  if (typeof value !== "string") return;
  const url = externalUrl(value);
  if (url !== undefined) actions.openExternal(url);
}
