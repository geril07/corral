import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogFooter,
} from "./alert-dialog.tsx";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogFooter,
} from "./dialog.tsx";
import { CommandDialog } from "./command.tsx";
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
  onClose: () => void;
  children: ReactNode;
}

const DestructiveContext = createContext(false);

export function TaskCommandDialog({
  title,
  description,
  onClose,
  children,
}: Omit<DialogProps, "description"> & { description?: string }) {
  const focus = useDialogFocus();
  const fallback = useRef(currentOpener());
  const finalFocus = () => finalFocusTarget(focus?.target() ?? null, fallback.current);
  return (
    <CommandDialog
      open
      title={title}
      {...(description === undefined ? {} : { description })}
      onOpenChange={(open) => !open && onClose()}
      finalFocus={finalFocus}
    >
      {children}
    </CommandDialog>
  );
}

export function TaskDialog({
  title,
  description,
  onClose,
  showCloseButton = true,
  children,
}: DialogProps & { showCloseButton?: boolean }) {
  const focus = useDialogFocus();
  const fallback = useRef(currentOpener());
  const finalFocus = () => finalFocusTarget(focus?.target() ?? null, fallback.current);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        finalFocus={finalFocus}
        showCloseButton={showCloseButton}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function DestructiveTaskDialog({ title, description, onClose, children }: DialogProps) {
  const focus = useDialogFocus();
  const fallback = useRef(currentOpener());
  const finalFocus = () => finalFocusTarget(focus?.target() ?? null, fallback.current);
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        finalFocus={finalFocus}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <DestructiveContext value>{children}</DestructiveContext>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return useContext(DestructiveContext) ? (
    <AlertDialogFooter>{children}</AlertDialogFooter>
  ) : (
    <DialogFooter>{children}</DialogFooter>
  );
}

export { FieldError as FormError } from "./field.tsx";
