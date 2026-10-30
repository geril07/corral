import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { IconButton } from "./icon-button.tsx";

const popupClass =
  "z-[60] min-w-44 rounded-control border border-border bg-surface-raised py-1 text-text shadow-lg outline-none";

const itemClass =
  "flex h-7 cursor-default items-center gap-2 px-2.5 text-sm outline-none data-highlighted:bg-surface-active data-disabled:opacity-50";

/** A row's secondary and destructive actions behind one 28px trigger. */
export function OverflowMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={<IconButton label={label} icon="more" />} />
      <BaseMenu.Portal container={document.body}>
        <BaseMenu.Positioner align="end" sideOffset={4} className="z-[60]">
          <BaseMenu.Popup className={popupClass}>{children}</BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

export function MenuItem({
  danger,
  className,
  ...props
}: ComponentProps<typeof BaseMenu.Item> & { danger?: boolean }) {
  return <BaseMenu.Item className={cn(itemClass, danger && "text-danger", className)} {...props} />;
}
