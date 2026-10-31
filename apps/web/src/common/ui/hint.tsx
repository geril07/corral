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
  if (content === undefined || content === null || content === "") return children;
  return (
    <TooltipProvider>
      <Tooltip disableHoverablePopup>
        <TooltipTrigger render={children} />
        <TooltipContent side={side} role="tooltip">
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
