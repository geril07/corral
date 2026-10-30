import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";

export function Input({ className, ...props }: ComponentProps<typeof BaseInput>) {
  return (
    <BaseInput
      className={cn(
        "h-8 w-full min-w-0 rounded-control border border-border bg-surface px-2 text-text outline-none placeholder:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
