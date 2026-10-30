import { describeError } from "@corral/client/rpc-errors";
import { Label, MAX_LABEL_LENGTH } from "@corral/protocol/label";
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { useAttempt } from "../../common/hooks/use-attempt.ts";
import { Button, Dialog, DialogActions, Field, FormError, Input } from "../../common/ui/index.ts";

/** What a rename names: a session of a task or a loose terminal, both by their stable id. */
export interface RenameTarget {
  type: "session" | "terminal";
  id: string;
  /** The name the row shows now, for the dialog title. */
  name: string;
  /** The current custom name, `null` when the natural one is shown. */
  label: string | null;
}

interface RenameEntryDialogProps {
  target: RenameTarget;
  /** Resolves once the label is stored; a rejection is shown in the dialog. */
  onSave: (label: string | null) => Promise<void>;
  onClose: () => void;
}

const HELP = {
  session:
    "The session, its process and its conversation stay as they are; the server keeps the name through restarts. Leave it empty for the natural name.",
  terminal:
    "The terminal keeps running. A terminal outside a task ends with the server, so the name lasts until then. Leave it empty for the natural name.",
} as const;

/** Enter saves, Escape cancels; an empty name gives the entry its natural one back. */
export function RenameEntryDialog({ target, onSave, onClose }: RenameEntryDialogProps) {
  const attempt = useAttempt();
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string>();

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
    if (name !== "" && !Label.safeParse(name).success) {
      setProblem(`A name is one line of at most ${MAX_LABEL_LENGTH} characters.`);
      return;
    }
    setProblem(undefined);
    void attempt.run(() => onSave(name === "" ? null : name));
  };

  return (
    <Dialog title={`Rename ${target.name}`} description={HELP[target.type]} onClose={onClose}>
      <form onSubmit={save}>
        <Field label="Name">
          <Input ref={input} defaultValue={target.label ?? ""} />
        </Field>
        {(problem ?? (attempt.failed ? describeError(attempt.error) : undefined)) && (
          <FormError>{problem ?? describeError(attempt.error)}</FormError>
        )}
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={attempt.pending}>
            Save
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
