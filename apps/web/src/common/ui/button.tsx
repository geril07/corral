import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, Ref } from "react";
import { cn } from "../lib/cn.ts";

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-control border font-medium outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "border-border bg-surface text-text hover:bg-surface-active",
        primary:
          "border-accent-strong bg-accent-strong text-accent-foreground hover:bg-accent-strong/90",
        danger:
          "border-danger-strong bg-danger-strong text-danger-foreground hover:bg-danger-strong/90",
        ghost: "border-transparent bg-transparent text-text hover:bg-surface-active",
        "ghost-muted":
          "border-transparent bg-transparent text-text-muted hover:bg-surface-active hover:text-text",
        "ghost-danger": "border-transparent bg-transparent text-text-muted hover:text-danger",
        link: "border-transparent bg-transparent text-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3 text-sm",
        sm: "h-7 px-2 text-xs",
        icon: "size-8",
        "icon-sm": "size-7",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  ref?: Ref<HTMLButtonElement> | undefined;
}

export function Button({ className, variant, size, type = "button", ref, ...props }: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
