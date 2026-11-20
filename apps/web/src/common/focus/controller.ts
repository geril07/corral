import {
  areaOf,
  defaultInArea,
  findInArea,
  FOCUS_AREA_ORDER,
  SELECTED_TAB_SELECTOR,
  visibleAreaElements,
  type FocusArea,
} from "./areas.ts";
import { focusable, isShown } from "./visibility.ts";

/** Where a focus request wants the keyboard, and what to take if that control is not there yet. */
export interface AreaFocusTarget {
  area: FocusArea;
  /** Skip the remembered control: a tab close hands the pane its keyboard, not the old control. */
  prefer?: "pane" | "row" | undefined;
  /** A named control in the area; the request waits for it instead of taking a fallback. */
  selector?: string | undefined;
  /** The tab that must be selected before the pane is taken; a close changes the selection. */
  tab?: string | undefined;
}

export interface AreaFocusController {
  /** The next/previous shown area; false when a single area or an overlay owns the keyboard. */
  move: (direction: 1 | -1) => boolean;
  focusArea: (area: FocusArea) => boolean;
  /** Retries after React commits, cancels on user input, and gives up after two seconds. */
  request: (target: AreaFocusTarget) => void;
  dispose: () => void;
}

const REQUEST_TIMEOUT_MS = 2000;
const SETTLE_MS = 500;

/** A modal or a focused menu owns the keyboard; an area move must not leave it. */
export function overlayOwnsKeyboard(doc: Document): boolean {
  const active = doc.activeElement;
  if (
    active?.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') !==
    null
  )
    return true;
  return Array.from(
    doc.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [aria-modal="true"]'),
  ).some(isShown);
}

function visibleRoots(doc: Document, area: FocusArea): HTMLElement[] {
  return visibleAreaElements(doc, area);
}

/** A control the area restores after its element was lost; then one still showing. */
function remounted(doc: Document, area: FocusArea, lost: HTMLElement): HTMLElement | null {
  const label = lost.getAttribute("aria-label");
  for (const root of visibleRoots(doc, area)) {
    if (lost.id !== "") {
      const byId = root.querySelector<HTMLElement>(`#${CSS.escape(lost.id)}`);
      if (byId !== null && areaOf(byId) === area && focusable(byId) !== null) return byId;
    }
    if (label === null) continue;
    for (const candidate of root.querySelectorAll<HTMLElement>("[aria-label]")) {
      if (candidate.getAttribute("aria-label") === label && areaOf(candidate) === area)
        return focusable(candidate);
    }
  }
  return null;
}

export function createAreaFocusController(doc: Document): AreaFocusController {
  const lastFocused = new Map<FocusArea, HTMLElement>();
  let lastArea: FocusArea | undefined;
  // The controller's own `.focus()` calls fire `focusin` too. Only another actor's focus
  // cancels a pending request, and only when it lands on a tab: a pane request must not take
  // the keyboard back from a tab the user focused for its menu.
  let focusing = false;
  const focusElement = (element: HTMLElement): boolean => {
    focusing = true;
    try {
      element.focus({ preventScroll: true });
    } finally {
      focusing = false;
    }
    const active = doc.activeElement;
    return active === element || element.contains(active);
  };

  const remember = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (!focusing && pending !== undefined && target.closest('[role="tab"]') !== null)
      cancelRequest();
    const area = areaOf(target);
    if (area === undefined) return;
    lastFocused.set(area, target);
    lastArea = area;
  };

  const focusWithin = (
    area: FocusArea,
    options: {
      restore: boolean;
      prefer?: "pane" | "row" | undefined;
      selector?: string | undefined;
      tab?: string | undefined;
    },
  ): boolean => {
    const roots = visibleRoots(doc, area);
    if (roots.length === 0) return false;
    // A layout write and the DOM commit that shows it are different moments. Until the tab strip
    // names the new tab, the pane still on screen belongs to the old one.
    if (options.tab !== undefined) {
      const selected = roots
        .map((root) => findInArea(root, area, SELECTED_TAB_SELECTOR))
        .find((element) => element !== null);
      if (selected?.getAttribute("data-tab-id") !== options.tab) return false;
    }
    if (options.selector !== undefined) {
      for (const root of roots) {
        const named = findInArea(root, area, options.selector);
        if (named !== null && focusElement(named)) return true;
      }
      return false;
    }
    const previous = options.restore ? lastFocused.get(area) : undefined;
    if (
      previous !== undefined &&
      areaOf(previous) === area &&
      focusable(previous) !== null &&
      isShown(previous) &&
      focusElement(previous)
    )
      return true;
    for (const root of roots) {
      // The request's `tab` guard already waited for the commit that selects the target tab, so
      // this default can never be the pane the action is leaving.
      const preferred = defaultInArea(root, area, options.prefer);
      if (preferred !== null && focusElement(preferred)) return true;
      if (focusElement(root)) return true;
    }
    return false;
  };

  let pending: AreaFocusTarget | undefined;
  let frame = 0;
  let settleFrame = 0;
  let settling = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let cancelOnInput = false;
  const observer = new MutationObserver(() => schedule());
  const cancelRequest = () => {
    pending = undefined;
    settling = false;
    cancelOnInput = false;
    observer.disconnect();
    cancelAnimationFrame(frame);
    cancelAnimationFrame(settleFrame);
    if (deadline !== undefined) clearTimeout(deadline);
    deadline = undefined;
  };
  // A request made in the same tick as a layout write can focus the pane that is about to
  // unmount. Watch the target for a bounded moment: if the commit takes it away and leaves the
  // page, ask again for the control that replaced it.
  const startSettle = () => {
    settling = true;
    cancelAnimationFrame(settleFrame);
    const until = performance.now() + SETTLE_MS;
    const check = () => {
      if (pending === undefined) return;
      if (doc.activeElement === doc.body) {
        settling = false;
        schedule();
        return;
      }
      if (performance.now() >= until) {
        cancelRequest();
        return;
      }
      settleFrame = requestAnimationFrame(check);
    };
    settleFrame = requestAnimationFrame(check);
  };
  const schedule = () => {
    if (settling) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (pending === undefined) return;
      const target = pending;
      if (
        focusWithin(target.area, {
          // A named preference is the reason the request exists: do not restore the control the
          // action is replacing (the pane input after a tab close, the row after a settle).
          restore: target.prefer === undefined,
          prefer: target.prefer,
          selector: target.selector,
          tab: target.tab,
        })
      )
        startSettle();
    });
  };
  const request = (target: AreaFocusTarget) => {
    cancelRequest();
    pending = target;
    // The key or click that made the request may still be propagating.
    queueMicrotask(() => {
      if (pending === target) cancelOnInput = true;
    });
    observer.observe(doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["inert", "aria-hidden", "hidden", "aria-selected", "data-hidden"],
    });
    deadline = setTimeout(() => {
      if (pending === undefined) return;
      // Nothing the request named ever appeared. If the keyboard is on the page, the area's own
      // default is still better than `body`; otherwise whatever the user focused stays.
      const body = doc.activeElement === doc.body;
      const area = pending.area;
      cancelRequest();
      if (body) focusWithin(area, { restore: true });
    }, REQUEST_TIMEOUT_MS);
    schedule();
  };
  const onUserInput = () => {
    if (cancelOnInput) cancelRequest();
  };

  // Focus that drops to the body because its element was hidden, made inert, or removed
  // returns to the same control when it remounted, else to its area; never to `body`.
  let recoveryFrame = 0;
  const recover = (event: FocusEvent) => {
    const lost = event.target;
    if (!(lost instanceof HTMLElement) || event.relatedTarget !== null) return;
    const area = areaOf(lost);
    if (area === undefined) return;
    cancelAnimationFrame(recoveryFrame);
    recoveryFrame = requestAnimationFrame(() => {
      if (doc.activeElement !== doc.body || !doc.hasFocus() || isShown(lost)) return;
      const again = remounted(doc, area, lost);
      if (again !== null && focusElement(again)) return;
      if (focusWithin(area, { restore: true })) return;
      // The area itself went away (a hidden sidebar, an emptied group): the work surface keeps
      // the keyboard instead of dropping it to the page.
      for (const next of ["main", "sidebar", "companion", "status"] as const) {
        if (next !== area && focusWithin(next, { restore: true })) return;
      }
    });
  };

  doc.addEventListener("focusin", remember);
  doc.addEventListener("focusout", recover);
  doc.addEventListener("pointerdown", onUserInput, true);
  doc.addEventListener("keydown", onUserInput, true);

  return {
    move: (direction) => {
      cancelRequest();
      if (overlayOwnsKeyboard(doc)) return false;
      const shown = FOCUS_AREA_ORDER.filter((area) => visibleRoots(doc, area).length > 0);
      if (shown.length < 2) return false;
      const current = areaOf(doc.activeElement) ?? lastArea;
      let index = current === undefined ? -1 : shown.indexOf(current);
      if (index === -1) index = direction === 1 ? -1 : 0;
      const area = shown[(index + direction + shown.length) % shown.length];
      return area === undefined ? false : focusWithin(area, { restore: true });
    },
    focusArea: (area) => focusWithin(area, { restore: true }),
    request,
    dispose: () => {
      cancelRequest();
      cancelAnimationFrame(recoveryFrame);
      doc.removeEventListener("focusin", remember);
      doc.removeEventListener("focusout", recover);
      doc.removeEventListener("pointerdown", onUserInput, true);
      doc.removeEventListener("keydown", onUserInput, true);
    },
  };
}

let active: AreaFocusController | undefined;

/** Starts the cycle for a mounted shell; `desktop` adds F6, which a browser page keeps. */
export function startShellFocus({ desktop }: { desktop: boolean }): () => void {
  const controller = createAreaFocusController(document);
  active = controller;
  let stopKeys: (() => void) | undefined;
  if (desktop) {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "F6" || event.repeat || event.isComposing) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      // F6 is the browser's own focus-chrome key on the web; consuming it here keeps the page's
      // keyboard model, and a dialog still owns the move.
      event.preventDefault();
      if (overlayOwnsKeyboard(document)) return;
      controller.move(event.shiftKey ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    stopKeys = () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }
  return () => {
    stopKeys?.();
    controller.dispose();
    if (active === controller) active = undefined;
  };
}

/** An action or a dialog close asks the mounted shell for the keyboard after its commit. */
export function requestAreaFocus(target: AreaFocusTarget): void {
  active?.request(target);
}

/** The prefix's area chords; false when the shell is not mounted or has one area. */
export function moveAreaFocus(direction: 1 | -1): boolean {
  return active?.move(direction) ?? false;
}
