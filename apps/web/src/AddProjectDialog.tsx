import { describeError } from "@corral/client/rpc-errors";
import { useState } from "react";
import { Modal } from "./Modal.tsx";
import { useAttempt } from "./use-attempt.ts";

interface AddProjectDialogProps {
  /** Resolves once the project is added; a rejection is shown in the dialog. */
  onAdd: (path: string) => Promise<void>;
  onClose: () => void;
}

export function AddProjectDialog({ onAdd, onClose }: AddProjectDialogProps) {
  const [path, setPath] = useState("");
  const attempt = useAttempt();

  return (
    <Modal
      title="Add project"
      description="Any directory inside a git repository works."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void attempt.run(() => onAdd(path.trim()));
        }}
      >
        <label className="field">
          Repository path
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/home/me/code/repo"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        {attempt.failed && (
          <p className="form-error" role="alert">
            {describeError(attempt.error)}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!path.trim() || attempt.pending}>
            Add project
          </button>
        </div>
      </form>
    </Modal>
  );
}
