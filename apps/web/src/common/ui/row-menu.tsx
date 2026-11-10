import { ContextMenu } from "@base-ui/react/context-menu";
import type { ReactElement, ReactNode } from "react";
import { Hint } from "./hint.tsx";

/** The popup of a row's secondary actions, shared by RowMenu and a row that owns its own trigger. */
export function RowMenuPopup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Positioner className="isolate z-50 outline-none" sideOffset={4}>
        <ContextMenu.Popup
          aria-label={label}
          className="max-h-(--available-height) min-w-44 max-w-(--available-width) overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-floating outline-none"
        >
          {children}
        </ContextMenu.Popup>
      </ContextMenu.Positioner>
    </ContextMenu.Portal>
  );
}

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
      <RowMenuPopup label={label}>{children}</RowMenuPopup>
    </ContextMenu.Root>
  );
}
