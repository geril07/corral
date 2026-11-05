/**
 * The sidebar list's keyboard target. It lives outside `sidebar.tsx` because React Refresh
 * invalidates a component module that also exports plain helpers, and the rows' selector, the
 * footer fallback and the row lookup are read by the workspace action as well as the view.
 */

/** Every row the list's arrows walk, in the order the sidebar shows them. */
export const SIDEBAR_ROW_SELECTOR = "[data-sidebar-row]";

/** The footer control the list falls back to when it has no rows at all. */
export const ADD_PROJECT_BUTTON_ID = "workspace-add-project";

/** The focused row, when the key came from one; the list's headers leave the keys alone. */
export function sidebarRowOf(event: { readonly target: EventTarget | null }): HTMLElement | null {
  return event.target instanceof HTMLElement
    ? event.target.closest<HTMLElement>(SIDEBAR_ROW_SELECTOR)
    : null;
}

/**
 * The row `prefix w` gives the keyboard to: the current one (`aria-current`), else the list's
 * first. A group header, the Settled toggle and Scratch are headers, not rows.
 */
export function sidebarRowTarget(root: ParentNode = document): HTMLElement | null {
  return (
    root.querySelector<HTMLElement>(`${SIDEBAR_ROW_SELECTOR}[aria-current="true"]`) ??
    root.querySelector<HTMLElement>(SIDEBAR_ROW_SELECTOR)
  );
}
