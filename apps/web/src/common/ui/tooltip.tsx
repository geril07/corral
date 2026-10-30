import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../lib/cn.ts";

const tooltipPopupClass =
  "z-[60] max-w-80 rounded-control border border-border bg-surface-raised px-2 py-1 text-text shadow-lg";

/** A tooltip around one trigger element; the trigger keeps its own role and keyboard behaviour. */
export function Tooltip({
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
    <BaseTooltip.Provider delay={300}>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger render={children} />
        <BaseTooltip.Portal container={document.body}>
          <BaseTooltip.Positioner side={side} sideOffset={4} className="z-[60]">
            <BaseTooltip.Popup role="tooltip" className={cn(tooltipPopupClass, className)}>
              {content}
            </BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </BaseTooltip.Provider>
  );
}
