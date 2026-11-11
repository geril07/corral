import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.ts";

const inputVariants = cva(
  "h-8 w-full min-w-0 rounded-(--control-radius) border border-input bg-transparent px-3 py-1 text-sm outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
  {
    variants: {
      frame: {
        // The field of a hover row (Settings search): no border, background or block padding, the
        // row's 30 px height, and the row's free width. No ring either — the caret is the field's
        // focus indicator (`ui-kit.md`, **Focus**).
        bare: "h-[30px] flex-auto border-0 bg-transparent px-0 py-0 dark:bg-transparent",
      },
    },
  },
);

function Input({
  className,
  type,
  frame,
  ...props
}: React.ComponentProps<"input"> & VariantProps<typeof inputVariants>) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(inputVariants({ frame, className }))}
      {...props}
    />
  );
}

export { Input, inputVariants };
