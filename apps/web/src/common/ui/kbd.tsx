import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";

export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center rounded-control bg-text/10 px-1 font-sans text-xs text-text-muted",
        className,
      )}
      {...props}
    />
  );
}
