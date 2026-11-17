import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "../lib/cn.ts";

/**
 * A compact one-of-N choice: the segments share one muted track and the checked one takes the
 * surface. The radio primitives keep the semantics, the arrow keys and the hidden input; the whole
 * segment is the target, so no separate dot and label have to line up.
 */
function SegmentedControl({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="segmented-control"
      className={cn(
        "inline-flex w-full items-center gap-0.5 rounded-(--control-radius) bg-muted p-0.5",
        className,
      )}
      {...props}
    />
  );
}

function SegmentedOption({ className, children, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="segmented-option"
      className={cn(
        "flex h-7 min-w-0 flex-1 items-center justify-center rounded-(--control-radius) px-2 text-sm text-muted-foreground select-none outline-hidden focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-background data-checked:text-foreground data-checked:shadow-xs data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </RadioPrimitive.Root>
  );
}

export { SegmentedControl, SegmentedOption };
