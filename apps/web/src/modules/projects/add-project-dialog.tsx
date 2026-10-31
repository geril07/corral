import { describeError } from "@corral/client/rpc-errors";
import { useState } from "react";
import { useAttempt } from "../../common/hooks/use-attempt.ts";
import {
  Button,
  TaskDialog,
  DialogActions,
  FieldLabel,
  FormError,
  Input,
} from "../../common/ui/index.ts";

interface AddProjectDialogProps {
  /** Resolves once the project is added; a rejection is shown in the dialog. */
  onAdd: (path: string) => Promise<void>;
  onClose: () => void;
}

export function AddProjectDialog({ onAdd, onClose }: AddProjectDialogProps) {
  const [path, setPath] = useState("");
  const attempt = useAttempt();

  return (
    <TaskDialog
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
        <FieldLabel className="mb-2.5 w-full flex-col items-start gap-1 text-muted-foreground">
          Repository path
          <Input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/home/me/code/repo"
            spellCheck={false}
            autoComplete="off"
          />
        </FieldLabel>
        {attempt.failed && <FormError>{describeError(attempt.error)}</FormError>}
        <DialogActions>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="default" disabled={!path.trim() || attempt.pending}>
            Add project
          </Button>
        </DialogActions>
      </form>
    </TaskDialog>
  );
}
