import { Label, MAX_LABEL_LENGTH } from "@corral/protocol/label";
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  TaskDialog,
  DialogActions,
  FormField,
  FormError,
  Input,
} from "../../common/ui/index.ts";

/** What a rename names: a task's title, a session or a loose terminal, all by their stable id. */
export interface RenameTarget {
  type: "task" | "session" | "terminal";
  id: string;
  /** The name shown now, for the dialog title. */
  name: string;
  /** What the field starts with: a task's title, or the custom name when an entry has one. */
  value: string;
}

interface RenameDialogProps {
  target: RenameTarget;
  /** Starts the save; the dialog closes at once, and a refusal is the workspace's notice. */
  onSave: (name: string | null) => void;
  onClose: () => void;
}

const HELP: Readonly<Record<RenameTarget["type"], string>> = {
  task: "Only the title changes: the branch and the worktree keep their names, and the task keeps its sessions.",
  session:
    "The session, its process and its conversation stay as they are; the server keeps the name through restarts. Leave it empty for the natural name.",
  terminal:
    "The terminal keeps running. A terminal outside a task ends with the server, so the name lasts until then. Leave it empty for the natural name.",
};

/** Enter saves, Escape cancels; an empty name gives an entry its natural one back, a task needs one. */
export function RenameDialog({ target, onSave, onClose }: RenameDialogProps) {
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string>();
  const renamesTask = target.type === "task";

  // After the dialog that opened it has handed focus back to the terminal, not before.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const name = input.current?.value.trim() ?? "";
    if (name === "") {
      if (renamesTask) {
        setProblem("A task needs a title.");
        return;
      }
    } else if (!renamesTask && !Label.safeParse(name).success) {
      setProblem(`A name is one line of at most ${MAX_LABEL_LENGTH} characters.`);
      return;
    }
    setProblem(undefined);
    onSave(name === "" ? null : name);
    onClose();
  };

  return (
    <TaskDialog title={`Rename ${target.name}`} description={HELP[target.type]} onClose={onClose}>
      <form className="grid gap-4" onSubmit={save}>
        <FormField label={renamesTask ? "Title" : "Name"}>
          <Input ref={input} defaultValue={target.value} />
        </FormField>
        {problem && <FormError>{problem}</FormError>}
        <DialogActions>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="outline" type="submit">
            Save
          </Button>
        </DialogActions>
      </form>
    </TaskDialog>
  );
}
