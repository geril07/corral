import { Checkbox as Primitive } from "@base-ui/react/checkbox";
import { CheckIcon, MinusIcon } from "lucide-react";

export function Checkbox({
  indeterminate,
  ...props
}: Omit<Primitive.Root.Props, "className" | "style" | "render" | "children">) {
  return (
    <Primitive.Root {...props} indeterminate={indeterminate} className="visual-checkbox">
      <Primitive.Indicator>
        {indeterminate ? (
          <MinusIcon className="size-3" strokeWidth={3} />
        ) : (
          <CheckIcon className="size-3" strokeWidth={3} />
        )}
      </Primitive.Indicator>
    </Primitive.Root>
  );
}
