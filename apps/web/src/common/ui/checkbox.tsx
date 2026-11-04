import { Checkbox as Primitive } from "@base-ui/react/checkbox";
import { CheckIcon, MinusIcon } from "lucide-react";

export function Checkbox({
  indeterminate,
  ...props
}: Omit<Primitive.Root.Props, "className" | "style" | "render" | "children">) {
  return (
    <Primitive.Root
      {...props}
      indeterminate={indeterminate}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-input bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground data-indeterminate:border-primary data-indeterminate:bg-primary data-indeterminate:text-primary-foreground data-disabled:opacity-50"
    >
      <Primitive.Indicator>
        {indeterminate ? <MinusIcon className="size-3" /> : <CheckIcon className="size-3" />}
      </Primitive.Indicator>
    </Primitive.Root>
  );
}
