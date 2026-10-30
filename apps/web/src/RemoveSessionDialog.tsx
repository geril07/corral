import { describeError } from "@corral/client/rpc-errors";
import type { Session } from "@corral/protocol/rpc";
import { ConfirmModal } from "./Modal.tsx";
import { useAttempt } from "./use-attempt.ts";

interface RemoveSessionDialogProps {
  session: Session;
  /** Resolves once the session is removed; a rejection is shown in the dialog. */
  onRemove: () => Promise<void>;
  onClose: () => void;
}

export function RemoveSessionDialog({ session, onRemove, onClose }: RemoveSessionDialogProps) {
  const attempt = useAttempt();
  const agent = session.kind !== "shell";

  return (
    <ConfirmModal
      title={`Remove the ${session.kind} session?`}
      description={
        agent
          ? "Stops it if it runs and forgets it. The agent's own conversation history is left alone."
          : "Stops it if it runs and forgets it."
      }
      onClose={onClose}
    >
      {attempt.failed && (
        <p className="form-error" role="alert">
          {describeError(attempt.error)}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="danger"
          disabled={attempt.pending}
          onClick={() => void attempt.run(onRemove)}
        >
          Remove session
        </button>
      </div>
    </ConfirmModal>
  );
}
