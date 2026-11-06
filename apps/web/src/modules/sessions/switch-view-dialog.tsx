import { describeError } from "@corral/client/rpc-errors";
import type { Session, SessionView } from "@corral/protocol/rpc";
import { useAttempt } from "../../common/hooks/use-attempt.ts";
import { Button, DestructiveTaskDialog, DialogActions, FormError } from "../../common/ui/index.ts";
import { describeLaunchError } from "./launch-error.ts";

interface SwitchViewDialogProps {
  session: Session;
  /** The view the session is about to open in. */
  target: SessionView;
  /** The agent is working, so the handoff aborts its turn first. */
  working: boolean;
  /** The agent is waiting for an answer, which switching cancels with the frontend. */
  waiting: boolean;
  /** Resolves once the session runs in the target view; a rejection stays in the dialog. */
  onSwitch: () => Promise<void>;
  onClose: () => void;
}

/**
 * Asked only while the agent is busy (`prefix v` goes straight through when it is idle): the
 * handoff stops one frontend and starts the other, so an in-flight turn and a request the agent is
 * waiting on cannot survive it. What does survive is the agent's own conversation, and the
 * description says both (`design.md`, **Terminal and chat**).
 */
export function SwitchViewDialog({
  session,
  target,
  working,
  waiting,
  onSwitch,
  onClose,
}: SwitchViewDialogProps) {
  const attempt = useAttempt();
  // Only a chat frontend has an abort channel. A terminal is closed with SIGHUP, so its turn is
  // cut rather than aborted and whatever pi had not written is lost — say which one this is.
  const fromChat = session.view === "chat";
  const losing = waiting
    ? fromChat
      ? "The agent is waiting for your answer. Switching cancels that request with the frontend."
      : "The agent is waiting for your answer. Switching closes its terminal and the request is lost."
    : working
      ? fromChat
        ? "The agent is working. Switching aborts the turn first."
        : "The agent is working. Switching closes its terminal first; what it has not written is lost."
      : "";
  return (
    <DestructiveTaskDialog
      title={`Switch the ${session.kind} session to ${target}?`}
      description={[losing, "The conversation it already wrote stays; what is in flight does not."]
        .filter(Boolean)
        .join(" ")}
      onClose={onClose}
    >
      {attempt.failed && (
        <FormError>{describeLaunchError(attempt.error) ?? describeError(attempt.error)}</FormError>
      )}
      <DialogActions>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={attempt.pending}
          onClick={() => void attempt.run(onSwitch)}
        >
          Switch to {target}
        </Button>
      </DialogActions>
    </DestructiveTaskDialog>
  );
}
