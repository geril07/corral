import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Button } from "./button.tsx";

/** The gap the floating action keeps from the selection and from the window's edges. */
const EDGE = 8;

/** A selection inside `scope` that the floating action currently offers itself for. */
interface SelectionActionState {
  text: string;
  /** The last line's rectangle, in viewport coordinates. */
  rect: DOMRect;
}

/**
 * The floating action a text selection raises (T3's `AssistantSelectionToolbar`, the pill its
 * assistant lane portals over a selection). The kit owns the pill and its placement; the module
 * names the words and says what the selection is for, by marking the containers a selection may be
 * acted on with `data-selection-action`. Only a selection that starts and ends inside one such
 * container, inside `scope`, raises it.
 *
 * The trigger is a real button: Tab reaches it while the selection is up, Escape dismisses it, and
 * pressing it never clears the selection first (`onPointerDown` is cancelled, as in T3).
 */
export function SelectionAction({
  scope,
  label,
  ariaLabel,
  onSelect,
}: {
  /** The element the selection must live in — the transcript, not the whole window. */
  scope: RefObject<HTMLElement | null>;
  /** The pill's visible word. */
  label: string;
  /** The button's accessible name, when the visible word alone is not the action. */
  ariaLabel?: string;
  onSelect: (text: string) => void;
}) {
  const [selection, setSelection] = useState<SelectionActionState>();
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const element = scope.current;
    if (element === null) return undefined;
    const clear = () => setSelection(undefined);
    const update = () => {
      const selected = window.getSelection();
      if (selected === null || selected.isCollapsed || selected.rangeCount === 0) {
        clear();
        return;
      }
      const range = selected.getRangeAt(0);
      const start = range.startContainer;
      const end = range.endContainer;
      const startElement = start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement;
      const endElement = end.nodeType === Node.ELEMENT_NODE ? end : end.parentElement;
      if (
        !(startElement instanceof Element) ||
        !(endElement instanceof Element) ||
        !element.contains(startElement) ||
        !element.contains(endElement) ||
        startElement.closest("[data-selection-action]") === null ||
        endElement.closest("[data-selection-action]") === null
      ) {
        clear();
        return;
      }
      const text = selected.toString().trim();
      const rects = range.getClientRects();
      const rect = rects.item(rects.length - 1) ?? range.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      // A selection scrolled out of the lane keeps its text; the action goes with the visible part.
      if (text === "" || rect.bottom < bounds.top || rect.top > bounds.bottom) {
        clear();
        return;
      }
      setSelection({ text, rect });
    };
    document.addEventListener("selectionchange", update);
    // Scrolling moves the selection's rectangle without a selection change.
    element.addEventListener("scroll", update, true);
    // Tab reaches the pill from the lane, as T3's toolbar does; it stays in the document otherwise.
    const focusOnTab = (event: KeyboardEvent) => {
      const button = buttonRef.current;
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        button === undefined ||
        button === null ||
        button.disabled ||
        (event.target instanceof Node && button.contains(event.target))
      ) {
        return;
      }
      const selected = window.getSelection();
      if (selected === null || selected.rangeCount === 0) return;
      const anchor = selected.getRangeAt(0).commonAncestorContainer;
      const node = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
      if (!(node instanceof Element) || !element.contains(node)) return;
      event.preventDefault();
      button.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", focusOnTab, true);
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("keydown", focusOnTab, true);
      element.removeEventListener("scroll", update, true);
    };
  }, [scope]);

  // Measured after paint so a pill near an edge is pulled inside the window instead of clipped.
  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (button === null || selection === undefined) return;
    const box = button.getBoundingClientRect();
    button.style.left = `${Math.max(EDGE, Math.min(selection.rect.right - box.width, window.innerWidth - box.width - EDGE))}px`;
    button.style.top = `${Math.max(EDGE, Math.min(selection.rect.top - box.height - EDGE, window.innerHeight - box.height - EDGE))}px`;
  }, [selection]);

  if (selection === undefined) return null;
  const dismiss = () => {
    window.getSelection()?.removeAllRanges();
    setSelection(undefined);
  };
  return createPortal(
    <Button
      ref={buttonRef}
      type="button"
      size="xs"
      variant="outline"
      aria-label={ariaLabel ?? label}
      className="fixed z-50"
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        const text = selection.text;
        dismiss();
        onSelect(text);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      {label}
    </Button>,
    document.body,
  );
}
