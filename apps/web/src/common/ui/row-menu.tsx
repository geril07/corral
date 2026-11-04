import { ContextMenu } from "@base-ui/react/context-menu";
import type { ReactElement, ReactNode } from "react";
import { Hint } from "./hint.tsx";

/** Secondary row actions need no permanent trigger or empty action gutter. */
export function RowMenu({
  trigger,
  label,
  hint,
  children,
}: {
  trigger: ReactElement;
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <ContextMenu.Root>
      <Hint content={hint}>
        <ContextMenu.Trigger render={trigger} />
      </Hint>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="isolate z-50 outline-none" sideOffset={4}>
          <ContextMenu.Popup
            aria-label={label}
            className="max-h-(--available-height) min-w-44 max-w-(--available-width) overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none"
          >
            {children}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
