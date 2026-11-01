/**
 * The rule every client applies to a link that is not the app itself: only ordinary web pages leave
 * for the OS browser (`docs/design.md`, **Local trust boundary**). Shared because the desktop shell
 * and the page each re-check it, and two copies of this decision would drift.
 */
export function externalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
