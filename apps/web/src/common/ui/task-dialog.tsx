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
import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";

const FINAL_FOCUS_SELECTOR =
  'textarea[aria-label="Message"], textarea[aria-label="Prompt"], .terminal-host .xterm-helper-textarea';

/** The selected view's input: the chat or task composer, else the terminal. */
export function workspaceInput(): HTMLElement | null {
  return document.querySelector<HTMLElement>(FINAL_FOCUS_SELECTOR);
}

/** The focused element if it still means something, else the terminal. */
function currentOpener(): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && active.isConnected)
    return active;
  return workspaceInput();
}

interface DialogFocus {
  remember: (opener?: HTMLElement | null) => void;
  target: () => HTMLElement | null;
}

const DialogFocusContext = createContext<DialogFocus | undefined>(undefined);

/**
 * Remembers what had the keyboard before a dialog or the sidebar list took it. Keyboard flows
 * remember the terminal; a pointer flow can pass the button it started from.
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
  return workspaceInput();
}

/** One focus-return policy for route dialogs and anchored pickers. */
export function useTaskFinalFocus(preferComposer = false) {
  const focus = useDialogFocus();
  const fallback = useRef(currentOpener());
  return () =>
    (preferComposer ? workspaceInput() : null) ??
    finalFocusTarget(focus?.target() ?? null, fallback.current);
}

export interface DialogProps {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

type DialogFinalFocus = ComponentProps<typeof DialogContent>["finalFocus"];
type DialogInitialFocus = ComponentProps<typeof DialogContent>["initialFocus"];
type AlertFinalFocus = ComponentProps<typeof AlertDialogContent>["finalFocus"];

const DestructiveContext = createContext(false);

export function TaskCommandDialog({
  title,
  description,
  onClose,
  children,
}: Omit<DialogProps, "description"> & { description?: string }) {
  const finalFocus = useTaskFinalFocus();
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
  layout = "default",
  initialFocus,
  finalFocus: explicitFinalFocus,
  children,
}: DialogProps & {
  showCloseButton?: boolean;
  layout?: "default" | "settings" | "picker" | "path-picker";
  /** Overrides where the keyboard starts, for a dialog that opens on a named control. */
  initialFocus?: DialogInitialFocus;
  /** Overrides the remembered opener, for a dialog opened from another dialog. */
  finalFocus?: DialogFinalFocus;
}) {
  const defaultFinalFocus = useTaskFinalFocus();
  const finalFocus = explicitFinalFocus ?? defaultFinalFocus;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className={
          layout === "settings"
            ? "flex h-[min(44rem,calc(100dvh-2rem))] w-[min(64rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden sm:max-w-none"
            : layout === "path-picker"
              ? "visual-path-dialog flex w-[32rem] max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden sm:max-w-none"
              : layout === "picker"
                ? "flex w-[36rem] max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden sm:max-w-none"
                : "max-h-[calc(100dvh-2rem)] overflow-y-auto"
        }
        padding={layout === "default" ? "default" : "none"}
        closeLabel={layout === "settings" ? "Back to workspace" : "Close"}
        initialFocus={initialFocus}
        finalFocus={finalFocus}
        showCloseButton={showCloseButton}
      >
        <DialogHeader
          className={
            layout === "settings"
              ? "shrink-0 border-b border-border px-5 py-4 pr-12"
              : layout === "picker" || layout === "path-picker"
                ? "sr-only"
                : undefined
          }
        >
          <DialogTitle render={layout === "settings" ? <h1 /> : <h2 />}>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function DestructiveTaskDialog({
  title,
  description,
  onClose,
  finalFocus: explicitFinalFocus,
  children,
}: DialogProps & { finalFocus?: AlertFinalFocus }) {
  const defaultFinalFocus = useTaskFinalFocus();
  const finalFocus = explicitFinalFocus ?? defaultFinalFocus;
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto [overflow-wrap:anywhere]"
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
