import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "../lib/cn.ts";

import { Button } from "./button.tsx";
import { XIcon } from "lucide-react";

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-scrim data-open:motion-safe:animate-in data-open:motion-safe:fade-in-0 data-closed:motion-safe:animate-out data-closed:motion-safe:fade-out-0 motion-safe:animation-duration-200",
        className,
      )}
      {...props}
    />
  );
}

/** Stock footers cancel the content box padding with negative margins; `none` has none to cancel. */
const DialogContentPadding = React.createContext<"default" | "none">("default");

// `motion-safe:animation-duration-200` carries the enter/exit duration without `transition-duration`. Tailwind's
// `duration-200` would leave `transition-property: all` in place, so a text-scale change would
// animate the popup's size and position instead of re-laying out at once.

function DialogContent({
  className,
  children,
  showCloseButton = true,
  padding = "default",
  closeLabel = "Close",
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  closeLabel?: string | undefined;
  /** `none` leaves the padding to the content, as the Command composition does. */
  padding?: "default" | "none";
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        data-padding={padding}
        className={cn(
          "visual-dialog fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 outline-none will-change-transform data-open:motion-safe:animate-in data-open:motion-safe:fade-in-0 data-open:motion-safe:zoom-in-95 data-closed:motion-safe:animate-out data-closed:motion-safe:fade-out-0 data-closed:motion-safe:zoom-out-95 motion-safe:animation-duration-200",
          className,
        )}
        {...props}
      >
        <DialogContentPadding value={padding}>{children}</DialogContentPadding>
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={<Button variant="ghost" className="visual-dialog-close" size="icon-sm" />}
          >
            <XIcon />
            <span className="sr-only">{closeLabel}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="dialog-header" className={cn("visual-card-header", className)} {...props} />
  );
}

function DialogFooter({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="dialog-footer" className={cn("visual-dialog-footer", className)} {...props}>
      {children}
    </div>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("visual-card-title", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("visual-card-text", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
