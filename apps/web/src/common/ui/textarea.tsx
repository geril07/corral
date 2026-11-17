import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.ts";

const textareaVariants = cva("visual-textarea resize-none field-sizing-content min-h-16 w-full", {
  variants: {
    frame: {
      composer: "",
    },
    layout: {
      // The new-task prompt rests at four lines and grows to half the view.
      prompt: "min-h-24 max-h-[50cqh] px-4 py-3",
      // The chat composer rests at two lines and grows to 13 rem before it scrolls.
      chat: "min-h-14 max-h-52 overflow-y-auto px-4 py-3",
    },
  },
});

function Textarea({
  className,
  layout,
  frame,
  ...props
}: React.ComponentProps<"textarea"> & VariantProps<typeof textareaVariants>) {
  return (
    <textarea
      data-slot="textarea"
      data-frame={frame}
      className={cn(textareaVariants({ layout, frame, className }))}
      {...props}
    />
  );
}

export { Textarea, textareaVariants };
