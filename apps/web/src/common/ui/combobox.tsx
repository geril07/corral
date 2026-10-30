import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Input } from "./input.tsx";

const popupClass =
  "z-[60] max-h-60 min-w-[var(--anchor-width)] overflow-y-auto rounded-control border border-border bg-surface-raised";

function Root<Value, Multiple extends boolean | undefined = false>(
  props: ComponentProps<typeof BaseCombobox.Root<Value, Multiple>>,
) {
  return <BaseCombobox.Root {...props} />;
}

function InputPart({ className, ...props }: ComponentProps<typeof BaseCombobox.Input>) {
  return (
    <BaseCombobox.Input
      render={<Input />}
      className={cn("data-[size=default]:h-8", className)}
      {...props}
    />
  );
}

export function ComboboxPopup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <BaseCombobox.Portal container={document.body}>
      <BaseCombobox.Positioner sideOffset={4} className="z-[60]">
        <BaseCombobox.Popup className={cn(popupClass, className)}>
          <BaseCombobox.Empty className="px-2 py-1 text-text-muted empty:hidden">
            No such branch.
          </BaseCombobox.Empty>
          {children}
        </BaseCombobox.Popup>
      </BaseCombobox.Positioner>
    </BaseCombobox.Portal>
  );
}

export const Combobox = {
  ...BaseCombobox,
  Root,
  Input: InputPart,
  Popup: ComboboxPopup,
};

export const ComboboxItem = BaseCombobox.Item;
export const ComboboxList = BaseCombobox.List;
