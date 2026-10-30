import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { cn } from "../lib/cn.ts";

const FINAL_FOCUS_SELECTOR = ".terminal-host .xterm-helper-textarea";

/** Returns the keyboard to the terminal when a dialog closes, where the user was before it. */
function focusTerminal(): HTMLElement | null {
  return document.querySelector<HTMLElement>(FINAL_FOCUS_SELECTOR);
}

/** The focused element if it still means something, else the terminal. */
function currentOpener(): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && active.isConnected)
    return active;
  return focusTerminal();
}

interface DialogFocus {
  remember: (opener?: HTMLElement | null) => void;
  target: () => HTMLElement | null;
}

const DialogFocusContext = createContext<DialogFocus | undefined>(undefined);

/**
 * Remembers what opened a dialog, before the dialog takes the focus. Keyboard flows remember the
 * terminal; a pointer flow can pass the button it started from.
 */
export function DialogFocusProvider({ children }: { children: ReactNode }) {
  const target = useRef<HTMLElement | null>(null);
  const value = useMemo<DialogFocus>(
    () => ({
      remember: (opener) => {
        target.current = opener ?? currentOpener();
      },
      target: () => target.current,
    }),
    [],
  );
  return <DialogFocusContext value={value}>{children}</DialogFocusContext>;
}

export function useDialogFocus(): DialogFocus | undefined {
  return useContext(DialogFocusContext);
}

/** Returns where the keyboard should go when this dialog closes. */
function finalFocusTarget(remembered: HTMLElement | null, fallback: HTMLElement | null) {
  if (remembered?.isConnected) return remembered;
  if (fallback?.isConnected) return fallback;
  return focusTerminal();
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
  const focus = useDialogFocus();
  const fallback = useRef<HTMLElement | null | undefined>(undefined);
  if (fallback.current === undefined) fallback.current = currentOpener();
  const finalFocus = () => finalFocusTarget(focus?.target() ?? null, fallback.current ?? null);
  return (
    <BaseDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={backdropClass} />
        <BaseDialog.Popup className={cn(popupClass, className)} finalFocus={finalFocus}>
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
  const focus = useDialogFocus();
  const fallback = useRef<HTMLElement | null | undefined>(undefined);
  if (fallback.current === undefined) fallback.current = currentOpener();
  const finalFocus = () => finalFocusTarget(focus?.target() ?? null, fallback.current ?? null);
  return (
    <BaseAlertDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <BaseAlertDialog.Portal>
        <BaseAlertDialog.Backdrop className={backdropClass} />
        <BaseAlertDialog.Popup className={popupClass} finalFocus={finalFocus}>
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
