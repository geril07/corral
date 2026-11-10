import { describeError, dirtyWorktreeFiles } from "@corral/client/rpc-errors";
import type { Task } from "@corral/protocol/rpc";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { useAttempt } from "../../common/hooks/use-attempt.ts";
import {
  Button,
  Item,
  DestructiveTaskDialog,
  DialogActions,
  FormError,
  useTaskDialogClose,
} from "../../common/ui/index.ts";
import { removalBranchCopy } from "./branch-facts.ts";

interface RemoveTaskDialogProps {
  task: Task;
  /** The preflight found the workspace directory already gone; the copy then says so. */
  workspaceMissing?: boolean;
  /** Reads the branch checked out in the worktree now; absent when the task has no worktree. */
  loadLiveBranch?: (() => Promise<string | null>) | undefined;
  /** Resolves once the task is removed; a rejection is shown in the dialog. */
  onRemove: (force: boolean) => Promise<void>;
  /** Where the keyboard goes when the dialog closes; the caller names the row that takes over. */
  finalFocus?: ComponentProps<typeof DestructiveTaskDialog>["finalFocus"];
  onClose: () => void;
}

export function RemoveTaskDialog({
  task,
  workspaceMissing = false,
  loadLiveBranch,
  onRemove,
  finalFocus,
  onClose,
}: RemoveTaskDialogProps) {
  const [live, setLive] = useState<{ taskId: string; branch: string | null }>();
  const liveBranch = live?.taskId === task.id ? live.branch : undefined;
  // The loader is read through a ref: its identity may change with the parent's render, but the
  // dialog asks once for this task, and a late answer after Cancel must not land.
  const loadBranch = useRef(loadLiveBranch);
  useEffect(() => {
    loadBranch.current = loadLiveBranch;
  }, [loadLiveBranch]);
  useEffect(() => {
    const load = loadBranch.current;
    if (workspaceMissing || !task.ownsWorktree || load === undefined) return undefined;
    let active = true;
    void load().then(
      (branch) => {
        if (active) setLive({ taskId: task.id, branch });
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [task.id, task.ownsWorktree, workspaceMissing]);
  const description = !task.ownsWorktree
    ? "Stops its sessions. The working tree stays; branches are not deleted."
    : workspaceMissing
      ? `The directory for this task's workspace is already gone at ${task.workspacePath}. Removing stops its sessions, closes the terminals in the workspace, including loose ones, prunes the stale git worktree entry, and keeps the branch.`
      : `Stops its sessions, closes the terminals in the workspace, including loose ones, and removes the worktree at ${task.workspacePath}. ${removalBranchCopy(liveBranch)}`;

  return (
    <DestructiveTaskDialog
      title={`Remove task "${task.title}"?`}
      description={description}
      finalFocus={finalFocus}
      onClose={onClose}
    >
      <RemoveTaskContent onRemove={onRemove} onClose={onClose} />
    </DestructiveTaskDialog>
  );
}

/**
 * The dialog's own actions. They sit inside the dialog's close context so a successful removal can
 * play the exit and let `finalFocus` name the row that takes over; a refusal keeps the dialog open.
 */
function RemoveTaskContent({
  onRemove,
  onClose,
}: {
  onRemove: (force: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const attempt = useAttempt();
  const closeDialog = useTaskDialogClose();
  const dirtyFiles = attempt.failed ? dirtyWorktreeFiles(attempt.error) : undefined;
  const cancel = () => {
    if (closeDialog === undefined) onClose();
    else closeDialog();
  };
  const remove = (force: boolean) =>
    void attempt.run(async () => {
      await onRemove(force);
      cancel();
    });

  return (
    <>
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
            <Button variant="outline" key="cancel-dirty" autoFocus onClick={cancel}>
              Cancel
            </Button>
            <Button
              key="force"
              variant="destructive"
              disabled={attempt.pending}
              onClick={() => remove(true)}
            >
              Remove anyway
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" key="cancel" onClick={cancel}>
              Cancel
            </Button>
            <Button
              key="remove"
              variant="destructive"
              disabled={attempt.pending}
              onClick={() => remove(false)}
            >
              Remove task
            </Button>
          </>
        )}
      </DialogActions>
    </>
  );
}
