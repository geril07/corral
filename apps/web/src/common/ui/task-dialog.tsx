import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
} from "./alert-dialog.tsx";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./dialog.tsx";
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";

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

export interface DialogProps {
  title: string;
  description?: ReactNode;
  /** Escape or a click outside asked to close. */
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

/** A dialog that is open while it is rendered; the caller stops rendering it to close it. */
export function TaskDialog({ title, description, onClose, children, className }: DialogProps) {
  const focus = useDialogFocus();
  const fallback = useRef<HTMLElement | null | undefined>(undefined);
  if (fallback.current === undefined) fallback.current = currentOpener();
  const finalFocus = () => finalFocusTarget(focus?.target() ?? null, fallback.current ?? null);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} className={className} finalFocus={finalFocus}>
        <DialogTitle className="mb-1 text-base">{title}</DialogTitle>
        {description && (
          <DialogDescription className="mb-3 text-muted-foreground">
            {description}
          </DialogDescription>
        )}
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** Like `Dialog`, for a destructive question: a click outside does not dismiss it. */
export function DestructiveTaskDialog({ title, description, onClose, children }: DialogProps) {
  const focus = useDialogFocus();
  const fallback = useRef<HTMLElement | null | undefined>(undefined);
  if (fallback.current === undefined) fallback.current = currentOpener();
  const finalFocus = () => finalFocusTarget(focus?.target() ?? null, fallback.current ?? null);
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent finalFocus={finalFocus}>
        <AlertDialogTitle className="mb-1 text-base">{title}</AlertDialogTitle>
        {description && (
          <AlertDialogDescription className="mb-3 text-muted-foreground">
            {description}
          </AlertDialogDescription>
        )}
        {children}
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="mt-1 flex justify-end gap-2">{children}</div>;
}

export function FormError({ children }: { children: ReactNode }) {
  return (
    <p className="mb-2.5 break-words text-destructive" role="alert">
      {children}
    </p>
  );
}
