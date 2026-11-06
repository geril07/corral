import { describeError } from "@corral/client/rpc-errors";
import type { Project } from "@corral/protocol/rpc";
import { useAttempt } from "../../common/hooks/use-attempt.ts";
import { Button, DestructiveTaskDialog, DialogActions, FormError } from "../../common/ui/index.ts";

interface RemoveProjectDialogProps {
  project: Project;
  /** What removal forgets besides the project; the dialog says it in words. */
  taskCount: number;
  /** Resolves once the project is removed; a rejection is shown in the dialog. */
  onRemove: () => Promise<void>;
  onClose: () => void;
}

export function RemoveProjectDialog({
  project,
  taskCount,
  onRemove,
  onClose,
}: RemoveProjectDialogProps) {
  const attempt = useAttempt();
  const tasks = taskCount === 1 ? "1 task" : `${taskCount} tasks`;
  // A project with nothing in it has no count to name; the project and the disk consequence
  // are the whole sentence.
  const description =
    taskCount === 0
      ? "Forgets this project; worktrees and branches stay on disk."
      : `Forgets this project and its ${tasks}; worktrees and branches stay on disk.`;

  return (
    <DestructiveTaskDialog
      title={`Remove project "${project.name}"?`}
      description={description}
      onClose={onClose}
    >
      {attempt.failed && <FormError>{describeError(attempt.error)}</FormError>}
      <DialogActions>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={attempt.pending}
          onClick={() => void attempt.run(onRemove)}
        >
          Remove project
        </Button>
      </DialogActions>
    </DestructiveTaskDialog>
  );
}
