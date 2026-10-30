import { useLayoutEffect, useState } from "react";

type TruncateMode = "end" | "middle";

interface Truncated {
  clipped: boolean;
  display: string;
}

/**
 * Reads whether `text` is wider than the element and, for middle truncation, shortens it around
 * an ellipsis so the end stays visible. ResizeObserver keeps it honest when the pane changes.
 */
export function useTruncatedText(text: string, mode: TruncateMode = "end") {
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const [state, setState] = useState<Truncated>({ clipped: false, display: text });

  useLayoutEffect(() => {
    if (!element) return undefined;
    const measure = () => {
      const width = element.clientWidth;
      if (width <= 0) return;
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) return;
      const style = getComputedStyle(element);
      context.font = style.font;
      if (context.measureText(text).width <= width + 0.5) {
        setState({ clipped: false, display: text });
        return;
      }
      if (mode === "end") {
        setState({ clipped: true, display: text });
        return;
      }
      setState({
        clipped: true,
        display: middleEllipsis(text, width, (value) => context.measureText(value).width),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, text, mode]);

  return { observe: setElement, ...state };
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
