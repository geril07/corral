import type { ReactNode, Ref } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./dropdown-menu.tsx";
import { IconButton } from "./icon-button.tsx";
import type { IconName } from "./icon.tsx";

/** A row's secondary actions share a named stock trigger. */
export function OverflowMenu({
  label,
  children,
  triggerRef,
  icon = "more",
  tooltip,
}: {
  label: string;
  children: ReactNode;
  triggerRef?: Ref<HTMLButtonElement> | undefined;
  /** The trigger's glyph; the tab strip's trailing "+" is the same stock menu. */
  icon?: IconName;
  tooltip?: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<IconButton ref={triggerRef} label={label} tooltip={tooltip} icon={icon} />}
      />
      <DropdownMenuContent align="end" className="min-w-44">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
