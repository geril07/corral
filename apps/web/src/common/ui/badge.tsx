import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";

const badgeVariants = cva(
  "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-control border border-transparent font-medium",
  {
    variants: {
      variant: {
        default: "bg-surface-active text-text-muted",
        danger: "bg-danger/10 text-danger",
      },
      size: {
        default: "h-4.5 px-1 text-xs",
        sm: "h-4 px-1 text-xs",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Badge({
  className,
  variant,
  size,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}
