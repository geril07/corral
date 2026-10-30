import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

const FINAL_FOCUS_SELECTOR = ".terminal-host .xterm-helper-textarea";

/** Returns the keyboard to the terminal when a dialog closes, where the user was before it. */
function focusTerminal(): HTMLElement | null {
  return document.querySelector<HTMLElement>(FINAL_FOCUS_SELECTOR);
}

const backdropClass = "fixed inset-0 z-40 bg-overlay";

const popupClass =
  "fixed top-[20vh] left-1/2 z-50 max-h-[70vh] w-[440px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-y-auto rounded-panel border border-border bg-surface-raised p-4 text-text outline-none";

export interface DialogProps {
  title: string;
  description?: ReactNode;
  /** Escape or a click outside asked to close. */
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

/** A dialog that is open while it is rendered; the caller stops rendering it to close it. */
export function Dialog({ title, description, onClose, children, className }: DialogProps) {
  return (
    <BaseDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={backdropClass} />
        <BaseDialog.Popup className={cn(popupClass, className)} finalFocus={focusTerminal}>
          <BaseDialog.Title className="mb-1 text-base">{title}</BaseDialog.Title>
          {description && (
            <BaseDialog.Description className="mb-3 text-text-muted">
              {description}
            </BaseDialog.Description>
          )}
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/** Like `Dialog`, for a destructive question: a click outside does not dismiss it. */
export function ConfirmDialog({ title, description, onClose, children }: DialogProps) {
  return (
    <BaseAlertDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <BaseAlertDialog.Portal>
        <BaseAlertDialog.Backdrop className={backdropClass} />
        <BaseAlertDialog.Popup className={popupClass} finalFocus={focusTerminal}>
          <BaseAlertDialog.Title className="mb-1 text-base">{title}</BaseAlertDialog.Title>
          {description && (
            <BaseAlertDialog.Description className="mb-3 text-text-muted">
              {description}
            </BaseAlertDialog.Description>
          )}
          {children}
        </BaseAlertDialog.Popup>
      </BaseAlertDialog.Portal>
    </BaseAlertDialog.Root>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="mt-1 flex justify-end gap-2">{children}</div>;
}

export function FormError({ children }: { children: ReactNode }) {
  return (
    <p className="mb-2.5 break-words text-danger" role="alert">
      {children}
    </p>
  );
}
