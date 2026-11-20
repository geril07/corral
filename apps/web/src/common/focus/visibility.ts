/** The two questions a focus move asks about an element: can it take focus, and is it shown. */

/** The element if the keyboard can land on it now; a removed, inert or disabled target is not. */
export function focusable(target: HTMLElement | null | undefined): HTMLElement | null {
  if (target === null || target === undefined || !target.isConnected) return null;
  // `inert` is the shell's own "this region is not live" marker. Base UI's temporary
  // `aria-hidden` on the outside of an open modal is not: it is removed before this focus runs.
  const hidden = target.closest<HTMLElement>("[inert]");
  if (hidden !== null && !hidden.hasAttribute("data-base-ui-inert")) return null;
  if (target.matches(":disabled, [aria-disabled=true]")) return null;
  const style = getComputedStyle(target);
  if (style.display === "none" || style.visibility === "hidden") return null;
  return target;
}

/** The first candidate that can take focus now, else `null`. */
export function firstFocusable(
  ...candidates: (HTMLElement | null | undefined)[]
): HTMLElement | null {
  for (const candidate of candidates) {
    const found = focusable(candidate);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Whether an element is on screen. `focusable` asks the same of controls, but an area is a plain
 * container: `aria-hidden` and a collapsed layout make it a place the keyboard must skip.
 */
export function isShown(target: HTMLElement | null | undefined): boolean {
  if (target === null || target === undefined || !target.isConnected) return false;
  if (target.closest("[inert]") !== null) return false;
  if (target.closest('[aria-hidden="true"]') !== null) return false;
  const style = getComputedStyle(target);
  if (style.display === "none" || style.visibility === "hidden") return false;
  return target.getClientRects().length > 0;
}
