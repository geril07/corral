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
          className="visual-menu w-max origin-(--transform-origin) data-[side=bottom]:motion-safe:slide-in-from-top-2 data-[side=inline-end]:motion-safe:slide-in-from-left-2 data-[side=inline-start]:motion-safe:slide-in-from-right-2 data-[side=left]:motion-safe:slide-in-from-right-2 data-[side=right]:motion-safe:slide-in-from-left-2 data-[side=top]:motion-safe:slide-in-from-bottom-2 data-open:motion-safe:animate-in data-open:motion-safe:fade-in-0 data-open:motion-safe:zoom-in-95"
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
