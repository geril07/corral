import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "../lib/cn.ts";

function Input({
  className,
  type,
  frame,
  ...props
}: React.ComponentProps<"input"> & {
  /** `bare` is the text of a hover row (Settings search): no box, shadow or block padding. */
  frame?: "bare" | undefined;
}) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      data-frame={frame}
      className={cn("visual-input", className)}
      {...props}
    />
  );
}

export { Input };
