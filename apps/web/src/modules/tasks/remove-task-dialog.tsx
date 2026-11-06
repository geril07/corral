import { describeError, dirtyWorktreeFiles } from "@corral/client/rpc-errors";
import type { Task } from "@corral/protocol/rpc";
import { useAttempt } from "../../common/hooks/use-attempt.ts";
import {
  Button,
  Item,
  DestructiveTaskDialog,
  DialogActions,
  FormError,
} from "../../common/ui/index.ts";

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
    <DestructiveTaskDialog
      title={`Remove task "${task.title}"?`}
      description={
        task.ownsWorktree
          ? `Stops its sessions, closes the terminals in the workspace, including loose ones, and removes the worktree at ${task.workspacePath}. The branch ${task.branch} stays.`
          : "Stops its sessions. The project's working tree and the branch stay."
      }
      onClose={onClose}
    >
      {dirtyFiles && (
        <div className="mb-3">
          <p className="mb-2.5 text-destructive" role="alert">
            The worktree has local changes, including ignored files, that removing it would lose:
          </p>
          <Item variant="outline">
            <ul className="max-h-40 w-full overflow-y-auto font-mono" aria-label="local changes">
              {dirtyFiles.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
          </Item>
        </div>
      )}
      {attempt.failed && !dirtyFiles && <FormError>{describeError(attempt.error)}</FormError>}
      <DialogActions>
        {/* Keyed apart from the first-step buttons so that the Enter that confirmed the first
            step cannot also confirm "Remove anyway": focus starts on Cancel again. */}
        {dirtyFiles ? (
          <>
            <Button variant="outline" key="cancel-dirty" autoFocus onClick={onClose}>
              Cancel
            </Button>
            <Button
              key="force"
              variant="destructive"
              disabled={attempt.pending}
              onClick={() => void attempt.run(() => onRemove(true))}
            >
              Remove anyway
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" key="cancel" onClick={onClose}>
              Cancel
            </Button>
            <Button
              key="remove"
              variant="destructive"
              disabled={attempt.pending}
              onClick={() => void attempt.run(() => onRemove(false))}
            >
              Remove task
            </Button>
          </>
        )}
      </DialogActions>
    </DestructiveTaskDialog>
  );
}
