import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.ts";

const textareaVariants = cva(
  "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
  {
    variants: {
      frame: {
        composer:
          "rounded-none border-0 bg-transparent shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent",
      },
      layout: {
        // The new-task composer's prompt: a four-line rest and a half-view growth cap
        // (`layout.md`, **New task view**). Font, padding, border and focus stay stock.
        prompt: "min-h-24 max-h-[50cqh]",
        // The chat composer rests at two lines and grows to 13 rem before it scrolls
        // (`layout.md`, **Chat**). Font, padding, border and focus stay stock.
        chat: "min-h-14 max-h-52 overflow-y-auto",
        // The Changes tab's commit message: one rest line in a toolbar row, growing as it is
        // typed (`layout.md`, **Changes**). Stock font, padding, border and focus.
        commit: "min-h-8",
      },
    },
  },
);

function Textarea({
  className,
  layout,
  frame,
  ...props
}: React.ComponentProps<"textarea"> & VariantProps<typeof textareaVariants>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(textareaVariants({ layout, frame, className }))}
      {...props}
    />
  );
}

export { Textarea, textareaVariants };
