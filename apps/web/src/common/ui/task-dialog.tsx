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
  useCallback,
  useContext,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

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

const TaskDialogCloseContext = createContext<(() => void) | undefined>(undefined);

/** Closes the owning dialog through its exit animation; its `onClose` runs when that ends. */
export function useTaskDialogClose(): (() => void) | undefined {
  return useContext(TaskDialogCloseContext);
}

export function TaskCommandDialog({
  title,
  description,
  onClose,
  finalFocus,
  children,
}: Omit<DialogProps, "description"> & {
  description?: string;
  finalFocus?: DialogFinalFocus;
}) {
  const [open, setOpen] = useState(true);
  const close = useCallback(() => setOpen(false), []);
  return (
    <CommandDialog
      open={open}
      title={title}
      {...(description === undefined ? {} : { description })}
      onOpenChange={(next) => !next && setOpen(false)}
      onOpenChangeComplete={(next) => !next && onClose()}
      finalFocus={finalFocus}
    >
      <TaskDialogCloseContext value={close}>{children}</TaskDialogCloseContext>
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
  closeLabel,
  beforeClose,
  children,
}: DialogProps & {
  showCloseButton?: boolean;
  layout?: "default" | "settings" | "picker" | "path-picker";
  /** Overrides where the keyboard starts, for a dialog that opens on a named control. */
  initialFocus?: DialogInitialFocus;
  /** Where the keyboard returns; the caller names the row, tab or control that is still live. */
  finalFocus?: DialogFinalFocus;
  /** Overrides the close control's accessible name. */
  closeLabel?: string;
  /** A close request that may be refused (e.g. an unsaved draft); `false` keeps the dialog open. */
  beforeClose?: (() => boolean) | undefined;
}) {
  const finalFocus = explicitFinalFocus;
  const [open, setOpen] = useState(true);
  const close = useCallback(() => setOpen(false), []);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        if (beforeClose !== undefined && !beforeClose()) return;
        setOpen(false);
      }}
      onOpenChangeComplete={(next) => !next && onClose()}
    >
      <DialogContent
        className={
          layout === "settings"
            ? "flex h-[min(60rem,calc(100dvh-3rem))] w-[min(80rem,calc(100vw-3rem))] max-w-none flex-col gap-0 overflow-hidden sm:max-w-none lg:h-[min(60rem,calc(100dvh-5rem))] lg:w-[min(80rem,calc(100vw-5rem))]"
            : layout === "path-picker"
              ? "visual-dialog-anchored visual-path-dialog flex w-[32rem] max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-6rem)] flex-col gap-0 overflow-hidden sm:max-w-none"
              : layout === "picker"
                ? "visual-dialog-anchored flex w-[36rem] max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-6rem)] flex-col gap-0 overflow-hidden sm:max-w-none"
                : undefined
        }
        padding={layout === "default" ? "default" : "none"}
        closeLabel={closeLabel ?? (layout === "settings" ? "Close settings" : "Close")}
        initialFocus={initialFocus}
        finalFocus={finalFocus}
        showCloseButton={showCloseButton}
      >
        <DialogHeader
          className={
            layout === "settings" || layout === "picker" || layout === "path-picker"
              ? "sr-only"
              : undefined
          }
        >
          <DialogTitle render={layout === "settings" ? <h1 /> : <h2 />}>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <TaskDialogCloseContext value={close}>{children}</TaskDialogCloseContext>
      </DialogContent>
    </Dialog>
  );
}

export function DestructiveTaskDialog({
  title,
  description,
  onClose,
  finalFocus: explicitFinalFocus,
  beforeClose,
  children,
}: DialogProps & {
  finalFocus?: AlertFinalFocus;
  /** A close request that may be refused, e.g. while a destructive write is in flight. */
  beforeClose?: (() => boolean) | undefined;
}) {
  const finalFocus = explicitFinalFocus;
  const [open, setOpen] = useState(true);
  const close = useCallback(() => setOpen(false), []);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        if (beforeClose !== undefined && !beforeClose()) return;
        setOpen(false);
      }}
      onOpenChangeComplete={(next) => !next && onClose()}
    >
      <AlertDialogContent className="[overflow-wrap:anywhere]" finalFocus={finalFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <TaskDialogCloseContext value={close}>
          <DestructiveContext value>{children}</DestructiveContext>
        </TaskDialogCloseContext>
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
