import type { ReactElement, ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip.tsx";

/** Optional row hints must not intercept a click intended for the terminal or its opener. */
export function Hint({
  content,
  children,
  side = "top",
}: {
  content: ReactNode;
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
}) {
  // The trigger stays inside the same provider in every state: a row that starts or stops
  // clipping must not be remounted, or the focused row would lose focus and its ring.
  return (
    <TooltipProvider delay={300}>
      <Tooltip disableHoverablePopup>
        <TooltipTrigger render={children} />
        {content !== undefined && content !== null && content !== "" && (
          <TooltipContent side={side} role="tooltip">
            {content}
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  );
}
