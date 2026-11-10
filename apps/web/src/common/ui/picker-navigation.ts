import { useRef, useState, type RefObject } from "react";

/**
 * The keyboard highlight of one inline autocomplete list. Base UI owns virtual focus: the input
 * keeps DOM focus and the highlighted item travels with `aria-activedescendant`. Its loop parks
 * the highlight on the input at either end, so one more press at an end is dispatched through the
 * input to land on the opposite row; both pickers share this wrap and the stale-highlight rule.
 */
export function usePickerArrowWrap<K>({
  items,
  query,
  inputRef,
}: {
  items: readonly K[];
  query: string;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const [highlighted, setHighlighted] = useState<{ query: string; item: K }>();
  const lastArrow = useRef<"up" | "down" | undefined>(undefined);
  // A highlight belongs to the query it was made for: typing never leaves Enter on a stale row.
  const active =
    highlighted?.query === query && items.includes(highlighted.item) ? highlighted.item : undefined;
  const wrap = (key: "ArrowUp" | "ArrowDown") => {
    lastArrow.current = undefined;
    queueMicrotask(() => {
      inputRef.current?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  };
  return {
    active,
    reset: () => setHighlighted(undefined),
    /** Call from the input's keydown before Base UI handles the arrow. */
    noteKey: (event: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean }) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === "ArrowUp") lastArrow.current = "up";
      if (event.key === "ArrowDown") lastArrow.current = "down";
    },
    onItemHighlighted: (item: K | undefined, details: { reason?: string }) => {
      setHighlighted(item === undefined ? undefined : { query, item });
      if (item !== undefined || details.reason !== "keyboard" || active === undefined) return;
      const first = items[0];
      const last = items.at(-1);
      if (first === undefined || last === undefined || first === last) return;
      if (lastArrow.current === "up" && Object.is(active, first)) wrap("ArrowUp");
      else if (lastArrow.current === "down" && Object.is(active, last)) wrap("ArrowDown");
    },
  };
}
