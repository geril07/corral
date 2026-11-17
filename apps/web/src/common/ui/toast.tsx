import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Button } from "./button.tsx";
import { Icon, type IconName } from "./icon.tsx";

/**
 * The client's one toast manager. A caller raises feedback with `toast.add` from the handler that
 * caused it, so the answer outlives the menu or dialog that asked for it. The region is mounted
 * once by `AppProviders`; a toast raised before that mount is dropped, not queued, because no
 * surface can raise feedback before it is on screen.
 */
export const toast = ToastPrimitive.createToastManager();

/** The glyph a toast's `type` names. Anything else is a plain notice with no glyph. */
const TONES: Readonly<Record<string, IconName>> = {
  success: "status-done",
  error: "config",
};

/**
 * The provider and its one region: toasts stack from the bottom-right, the corner both references
 * use for feedback that is not anchored to a control (T3's `components/ui/toast.tsx`, OpenCode's
 * `shell/notifications/toast.tsx`). A raised toast carries its own lifetime and politeness through
 * `ToastManagerAddOptions`; `type` selects the glyph and the tone here.
 *
 * The stack geometry is shadcn's Base UI toast scaffold (`registry/bases/base/ui/toast.tsx`),
 * stated in `.visual-toast*` in the kit stylesheet: the manager keeps the newest toast first, so
 * index 0 is the card at the corner and the rest peek behind it until the stack is expanded.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <ToastPrimitive.Provider toastManager={toast}>
      {children}
      <ToastPrimitive.Portal>
        <ToastRegion />
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}

function ToastRegion() {
  const { toasts, close } = ToastPrimitive.useToastManager();
  return (
    <ToastPrimitive.Viewport data-slot="toast-viewport" className="visual-toast-region">
      {toasts.map((item, index) => {
        const failed = item.type === "error";
        const icon = item.type === undefined ? undefined : TONES[item.type];
        return (
          <ToastPrimitive.Root
            key={item.id}
            toast={item}
            data-slot="toast"
            data-behind={index === 0 ? undefined : "true"}
            data-tone={failed ? "error" : undefined}
            className="visual-toast"
            swipeDirection={["right", "down"]}
          >
            <div className="visual-toast-content">
              {icon !== undefined && (
                <span
                  data-slot="toast-icon"
                  data-tone={failed ? "error" : "success"}
                  className={cn(
                    "mt-0.5 flex h-5 shrink-0 items-center",
                    failed ? "text-destructive" : "text-status-done",
                  )}
                  aria-hidden="true"
                >
                  <Icon name={icon} />
                </span>
              )}
              <ToastPrimitive.Title
                data-slot="toast-title"
                className="min-w-0 flex-1 font-medium break-words"
              />
            </div>
            {/* Every card carries its own dismiss, as the scaffold does; the cards behind are
                hidden while collapsed, so only the front button is reachable or visible then.
                T3's corner orb: half outside the card's top-right corner
                (`toastCornerDismissClass` in `components/ui/toast.tsx`). */}
            <Button
              variant="ghost"
              size="icon-micro"
              aria-label="Dismiss notification"
              className="visual-toast-dismiss absolute -top-1.5 -right-1.5 rounded-full border border-border bg-popover"
              onClick={() => close(item.id)}
            >
              <Icon name="close" size="row" />
            </Button>
          </ToastPrimitive.Root>
        );
      })}
    </ToastPrimitive.Viewport>
  );
}
