import type { ReactElement, ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip.tsx";

/** Optional row hints must not intercept a click intended for the terminal or its opener. */
export function Hint({
  content,
  children,
  side = "top",
  className,
}: {
  content: ReactNode;
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
}) {
  if (content === undefined || content === null || content === "") return children;
  return (
    <TooltipProvider delay={300}>
      <Tooltip>
        <TooltipTrigger render={children} />
        <TooltipContent side={side} className={className}>
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
