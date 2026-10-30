import { describeError, dirtyWorktreeFiles } from "@corral/client/rpc-errors";
import type { Task } from "@corral/protocol/rpc";
import { ConfirmModal } from "./Modal.tsx";
import { useAttempt } from "./use-attempt.ts";

interface RemoveTaskDialogProps {
  task: Task;
  /** Resolves once the task is removed; a rejection is shown in the dialog. */
  onRemove: (force: boolean) => Promise<void>;
  onClose: () => void;
}

export function RemoveTaskDialog({ task, onRemove, onClose }: RemoveTaskDialogProps) {
  const attempt = useAttempt();
  const dirtyFiles = attempt.failed ? dirtyWorktreeFiles(attempt.error) : undefined;

  return (
    <ConfirmModal
      title={`Remove task "${task.title}"?`}
      description={
        task.ownsWorktree
          ? `Closes its terminals and removes the worktree at ${task.workspacePath}. The branch ${task.branch} stays.`
          : "Closes its terminals. The project's working tree and the branch stay."
      }
      onClose={onClose}
    >
      {dirtyFiles && (
        <div className="dirty">
          <p role="alert">The worktree has uncommitted changes that removing it would lose:</p>
          <ul aria-label="uncommitted files">
            {dirtyFiles.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </div>
      )}
      {attempt.failed && !dirtyFiles && (
        <p className="form-error" role="alert">
          {describeError(attempt.error)}
        </p>
      )}
      <div className="modal-actions">
        {/* Keyed apart from the first-step buttons so that the Enter that confirmed the first
            step cannot also confirm "Remove anyway": focus starts on Cancel again. */}
        {dirtyFiles ? (
          <>
            <button key="cancel-dirty" type="button" autoFocus onClick={onClose}>
              Cancel
            </button>
            <button
              key="force"
              type="button"
              className="danger"
              disabled={attempt.pending}
              onClick={() => void attempt.run(() => onRemove(true))}
            >
              Remove anyway
            </button>
          </>
        ) : (
          <>
            <button key="cancel" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              key="remove"
              type="button"
              className="danger"
              disabled={attempt.pending}
              onClick={() => void attempt.run(() => onRemove(false))}
            >
              Remove task
            </button>
          </>
        )}
      </div>
    </ConfirmModal>
  );
}
