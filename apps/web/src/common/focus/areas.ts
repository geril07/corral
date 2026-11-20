import { focusable, isShown } from "./visibility.ts";

/** The four places the keyboard can live; F6 and its prefix chords cycle them. */
export type FocusArea = "sidebar" | "main" | "companion" | "status";

/** Reading order: the list, the work, the split beside it, then the message band. */
export const FOCUS_AREA_ORDER: readonly FocusArea[] = ["sidebar", "main", "companion", "status"];

const AREA_ATTRIBUTE = "data-focus-area";

/**
 * The controls a pane offers, most specific first. Tried one selector at a time: a combined
 * selector would return DOM order, putting the tab strip ahead of the pane it controls.
 */
const PANE_SELECTORS: readonly string[] = [
  'textarea[aria-label="Message"]',
  'textarea[aria-label="Prompt"]',
  ".terminal-host .xterm-helper-textarea",
  // A live request card in the transcript is a control of last resort: a composer or the
  // selected tab is always the better landing place.
  '[aria-label="Agent request"] [role="radio"][aria-checked="true"]',
  '[aria-label="Agent request"] input',
  '[aria-label="Agent request"] textarea',
];

const SELECTED_TAB = '[data-tab-id][aria-selected="true"]';
const ANY_TAB = "[data-tab-id]";

/** The tab the DOM says is selected; a request can wait for the commit that selects it. */
export const SELECTED_TAB_SELECTOR = SELECTED_TAB;

const SIDEBAR_SELECTORS: readonly string[] = [
  '[data-task-id][aria-current="true"]',
  "[data-task-id]",
  '[aria-label="New task"]',
  '[aria-label="Search tasks…"]',
];

/** Where a bare area move lands: the list's current row, the pane, or the message's control. */
const AREA_DEFAULT_SELECTORS: Readonly<Record<FocusArea, readonly string[]>> = {
  sidebar: SIDEBAR_SELECTORS,
  main: [...PANE_SELECTORS, SELECTED_TAB, ANY_TAB],
  companion: [...PANE_SELECTORS, SELECTED_TAB, ANY_TAB],
  status: ["button:not(:disabled)"],
};

/** The Add control a group keeps when its last tab leaves: the strip's, else the empty state's. */
export const ADD_SESSION_SELECTOR =
  '.visual-tab-add [aria-label="Add session"], .visual-workspace-empty [aria-label="Add session"]';

const FOCUSABLE_SELECTOR =
  'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

export function isFocusArea(value: string | null | undefined): value is FocusArea {
  return (
    value !== null && value !== undefined && (FOCUS_AREA_ORDER as readonly string[]).includes(value)
  );
}

/** Props for an area that is already a landmark: the marker and a programmatic focus stop. */
export function focusAreaMarker(area: FocusArea) {
  return { "data-focus-area": area, tabIndex: -1 } as const;
}

/** Props for a container that becomes a named region of the area cycle. */
export function focusAreaProps(area: FocusArea, label: string) {
  return {
    "data-focus-area": area,
    role: "region",
    "aria-label": label,
    tabIndex: -1,
  } as const;
}

/** The nearest area: a status banner nested in main belongs to status, not main. */
export function areaOf(element: Element | null | undefined): FocusArea | undefined {
  const marker = element?.closest<HTMLElement>(`[${AREA_ATTRIBUTE}]`);
  const name = marker?.getAttribute(AREA_ATTRIBUTE);
  return isFocusArea(name) ? name : undefined;
}

export function areaElements(doc: Document, area: FocusArea): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>(`[${AREA_ATTRIBUTE}="${area}"]`));
}

/** The area's elements that are on screen; a hidden sidebar or group names none. */
export function shownAreaElements(doc: Document, area: FocusArea): HTMLElement[] {
  return areaElements(doc, area).filter(isShown);
}

/** The status banner while it shows, else the footer band's message rows. */
export function statusAreaElements(doc: Document): HTMLElement[] {
  const roots = shownAreaElements(doc, "status");
  const banner = roots.filter((root) => root.matches('[data-slot="connection-banner"]'));
  return [...banner, ...roots.filter((root) => !banner.includes(root))];
}

/**
 * The roots that make an area a stop. An empty region is not one: a hidden main group leaves
 * `<main>` on screen with only the companion's and the banner's controls, and neither belongs to
 * it, so the cycle must skip it instead of landing on a bare container.
 */
export function visibleAreaElements(doc: Document, area: FocusArea): HTMLElement[] {
  const roots = area === "status" ? statusAreaElements(doc) : shownAreaElements(doc, area);
  return roots.filter((root) => firstInArea(root, area) !== null);
}

/** Whether the control belongs to this area and no nearer one. */
export function belongsTo(element: HTMLElement, area: FocusArea): boolean {
  return areaOf(element) === area && focusable(element) !== null;
}

/** The first named control in the area, ignoring controls that a nested area owns. */
export function findInArea(
  root: HTMLElement,
  area: FocusArea,
  selector: string,
): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>(selector)) {
    if (belongsTo(element, area)) return element;
  }
  return null;
}

/** The area's own first control, for a pane that has no input yet. */
export function firstInArea(root: HTMLElement, area: FocusArea): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
    if (belongsTo(element, area)) return element;
  }
  return null;
}

/** The control the area prefers when no last-focused control is restored. */
export function defaultInArea(
  root: HTMLElement,
  area: FocusArea,
  prefer: "pane" | "row" | undefined,
): HTMLElement | null {
  const selectors =
    prefer === "pane"
      ? [...PANE_SELECTORS, SELECTED_TAB]
      : prefer === "row" && area === "sidebar"
        ? SIDEBAR_SELECTORS
        : AREA_DEFAULT_SELECTORS[area];
  for (const selector of selectors) {
    const found = findInArea(root, area, selector);
    if (found !== null) return found;
  }
  return firstInArea(root, area);
}
