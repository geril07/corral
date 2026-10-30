import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog } from "@base-ui/react/dialog";
import type { ReactNode } from "react";
import { terminalInput } from "./TerminalView.tsx";

interface ModalProps {
  title: string;
  description?: ReactNode;
  /** Escape, a click outside (dialogs only) or a close button asked to close. */
  onClose: () => void;
  children: ReactNode;
}

/**
 * A dialog that is open while it is rendered; the caller stops rendering it to close it.
 * `className` is added to the popup's, to size it differently from a small dialog.
 */
export function Modal({
  title,
  className,
  description,
  onClose,
  children,
}: ModalProps & { className?: string }) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="backdrop" />
        <Dialog.Popup
          className={className ? `modal ${className}` : "modal"}
          finalFocus={terminalInput}
        >
          <Dialog.Title className="modal-title">{title}</Dialog.Title>
          {description && (
            <Dialog.Description className="modal-description">{description}</Dialog.Description>
          )}
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Like `Modal`, for a destructive question: the click outside does not dismiss it. */
export function ConfirmModal({ title, description, onClose, children }: ModalProps) {
  return (
    <AlertDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="backdrop" />
        <AlertDialog.Popup className="modal" finalFocus={terminalInput}>
          <AlertDialog.Title className="modal-title">{title}</AlertDialog.Title>
          {description && (
            <AlertDialog.Description className="modal-description">
              {description}
            </AlertDialog.Description>
          )}
          {children}
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
