import type { ReactNode, Ref } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./dropdown-menu.tsx";
import { IconButton } from "./icon-button.tsx";

/** A row's secondary actions share a named stock trigger. */
export function OverflowMenu({
  label,
  children,
  triggerRef,
}: {
  label: string;
  children: ReactNode;
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<IconButton ref={triggerRef} label={label} icon="more" />} />
      <DropdownMenuContent align="end" className="min-w-44">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
