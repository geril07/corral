import { describeError } from "@corral/client/rpc-errors";
import type { Session } from "@corral/protocol/rpc";
import { useAttempt } from "../../common/hooks/use-attempt.ts";
import { Button, ConfirmDialog, DialogActions, FormError } from "../../common/ui/index.ts";

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
    <ConfirmDialog
      title={`Remove the ${session.kind} session?`}
      description={
        agent
          ? "Stops it if it runs and forgets it. The agent's own conversation history is left alone."
          : "Stops it if it runs and forgets it."
      }
      onClose={onClose}
    >
      {attempt.failed && <FormError>{describeError(attempt.error)}</FormError>}
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="danger"
          disabled={attempt.pending}
          onClick={() => void attempt.run(onRemove)}
        >
          Remove session
        </Button>
      </DialogActions>
    </ConfirmDialog>
  );
}
