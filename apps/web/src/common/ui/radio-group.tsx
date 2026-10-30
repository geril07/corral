import { Radio as BaseRadio } from "@base-ui/react/radio";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";

export function RadioGroup<Value>({
  className,
  ...props
}: ComponentProps<typeof BaseRadioGroup<Value>>) {
  return <BaseRadioGroup<Value> className={cn("flex flex-col gap-0.5", className)} {...props} />;
}

export function RadioGroupItem<Value>({
  className,
  ...props
}: ComponentProps<typeof BaseRadio.Root<Value>>) {
  return (
    <BaseRadio.Root<Value>
      className={cn(
        "inline-flex size-3 shrink-0 items-center justify-center rounded-full border border-text-muted outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring data-checked:border-accent data-checked:bg-accent",
        className,
      )}
      {...props}
    />
  );
}
