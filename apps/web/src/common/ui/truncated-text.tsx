import { useLayoutEffect, useState } from "react";

type TruncateMode = "end" | "middle";

interface Truncated {
  /** The text this measurement belongs to; any other text means the state is from before it. */
  text: string;
  clipped: boolean;
  display: string;
}

/**
 * Reads whether `text` is wider than the element and, for middle truncation, shortens it around
 * an ellipsis so the end stays visible. ResizeObserver keeps it honest when the pane changes.
 *
 * A **new text is shown at once, in full**, before anything is measured: the state a previous text
 * left behind must never stay on screen (switching tasks showed
 * the old task's branch). A measurement then narrows it; an element with no width yet (its first
 * paint, a hidden pane) gets measured when the observer reports a size, and a caller that never
 * attaches `observe` still renders the right text.
 */
export function useTruncatedText(text: string, mode: TruncateMode = "end") {
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const [state, setState] = useState<Truncated>({ text, clipped: false, display: text });
  // Derived, not stored: a text from another render is displayed as it is until its own
  // measurement arrives, so a stale `display` from the previous text can never be shown — with or
  // without an element, a width or a measurement.
  const current: Truncated = state.text === text ? state : { text, clipped: false, display: text };

  useLayoutEffect(() => {
    if (!element) return undefined;
    const measure = () => {
      // No width yet: the observer's next report is the measurement (`measure` below).
      const width = element.clientWidth;
      if (width <= 0) return;
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) return;
      const style = getComputedStyle(element);
      context.font = style.font;
      if (context.measureText(text).width <= width + 0.5) {
        setState({ text, clipped: false, display: text });
        return;
      }
      if (mode === "end") {
        setState({ text, clipped: true, display: text });
        return;
      }
      setState({
        text,
        clipped: true,
        display: middleEllipsis(text, width, (value) => context.measureText(value).width),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, text, mode]);

  return { observe: setElement, clipped: current.clipped, display: current.display };
}

/** The longest `start…end` that fits `width`, measured with `measure` (a canvas in the browser). */
function middleEllipsis(text: string, width: number, measure: (value: string) => number) {
  if (text.length <= 2) return text;
  let best = "…";
  let low = 0;
  let high = text.length - 1;
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const start = Math.ceil(keep / 2);
    const end = Math.floor(keep / 2);
    const candidate = keep === 0 ? "…" : `${text.slice(0, start)}…${text.slice(text.length - end)}`;
    if (measure(candidate) <= width) {
      best = candidate;
      low = keep + 1;
    } else high = keep - 1;
  }
  return best;
}
