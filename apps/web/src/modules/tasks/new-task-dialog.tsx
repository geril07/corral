import { describeError } from "@corral/client/rpc-errors";
import type { CreateTaskInput, Project } from "@corral/protocol/rpc";
import { useEffect, useState } from "react";
import { useAttempt } from "../../common/hooks/use-attempt.ts";
import {
  Button,
  Combobox,
  ComboboxItem,
  ComboboxList,
  Dialog,
  DialogActions,
  Field,
  FormError,
  Input,
  RadioGroup,
  RadioGroupItem,
} from "../../common/ui/index.ts";

type WorkspaceKind = CreateTaskInput["workspace"]["type"];

const KINDS: readonly { kind: WorkspaceKind; label: string }[] = [
  { kind: "new-branch", label: "New branch" },
  { kind: "existing-branch", label: "Existing branch" },
  { kind: "main-worktree", label: "Main worktree" },
];

const RADIO_ROW = "flex cursor-pointer items-center gap-2";

type Branches =
  | { status: "loading" }
  | { status: "loaded"; names: string[] }
  | { status: "failed"; error: unknown };

interface NewTaskDialogProps {
  project: Project;
  /** The branches to pick from for "Existing branch"; started when the dialog opens. */
  branches: Promise<string[]>;
  /** Resolves once the task is created; a rejection is shown in the dialog. */
  onCreate: (input: CreateTaskInput) => Promise<void>;
  onClose: () => void;
}

export function NewTaskDialog({
  project,
  branches: loading,
  onCreate,
  onClose,
}: NewTaskDialogProps) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<WorkspaceKind>("new-branch");
  const [branchName, setBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [existing, setExisting] = useState<string | null>(null);
  const [branches, setBranches] = useState<Branches>({ status: "loading" });
  const attempt = useAttempt();

  useEffect(() => {
    let current = true;
    loading.then(
      (names) => current && setBranches({ status: "loaded", names }),
      (error: unknown) => current && setBranches({ status: "failed", error }),
    );
    return () => {
      current = false;
    };
  }, [loading]);

  const workspace = (): CreateTaskInput["workspace"] | undefined => {
    if (kind === "main-worktree") return { type: kind };
    if (kind === "existing-branch") return existing ? { type: kind, branch: existing } : undefined;
    return {
      type: kind,
      ...(branchName.trim() && { branch: branchName.trim() }),
      ...(baseBranch.trim() && { baseBranch: baseBranch.trim() }),
    };
  };
  const chosenWorkspace = workspace();
  const ready = title.trim() !== "" && chosenWorkspace !== undefined && !attempt.pending;

  return (
    <Dialog title="New task" description={`In project ${project.name}.`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || !chosenWorkspace) return;
          void attempt.run(() =>
            onCreate({ projectId: project.id, title: title.trim(), workspace: chosenWorkspace }),
          );
        }}
      >
        <Field label="Title">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoComplete="off"
          />
        </Field>
        <fieldset className="mb-2.5 border-0 p-0">
          <legend className="mb-1 p-0 text-text-muted">Workspace</legend>
          <RadioGroup
            className="flex-row gap-3.5"
            value={kind}
            onValueChange={(next) => setKind(next)}
            onKeyDown={(event) => {
              // A radio does not submit its form on Enter; the dialog still does what Escape and
              // the Create button promise from anywhere inside the form.
              if (event.key !== "Enter") return;
              event.preventDefault();
              event.currentTarget.closest("form")?.requestSubmit();
            }}
          >
            {KINDS.map((option) => (
              <label key={option.kind} className={RADIO_ROW}>
                <RadioGroupItem value={option.kind} />
                {option.label}
              </label>
            ))}
          </RadioGroup>
        </fieldset>
        {kind === "new-branch" && (
          <>
            <Field label="Branch name (optional)">
              <Input
                value={branchName}
                onChange={(event) => setBranchName(event.target.value)}
                placeholder="named from the title"
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
            <Field label="Base branch (optional)">
              <Input
                value={baseBranch}
                onChange={(event) => setBaseBranch(event.target.value)}
                placeholder={project.defaultBaseBranch}
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
          </>
        )}
        {kind === "existing-branch" && (
          <BranchPicker branches={branches} value={existing} onChange={setExisting} />
        )}
        {kind === "main-worktree" && (
          <p className="mb-2.5 text-text-muted">
            Works directly in {project.path}, without a worktree.
          </p>
        )}
        {attempt.failed && <FormError>{describeError(attempt.error)}</FormError>}
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!ready}>
            Create task
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function BranchPicker({
  branches,
  value,
  onChange,
}: {
  branches: Branches;
  value: string | null;
  onChange: (branch: string | null) => void;
}) {
  if (branches.status === "failed") {
    return <FormError>{describeError(branches.error)}</FormError>;
  }
  const names = branches.status === "loaded" ? branches.names : [];
  return (
    <Combobox.Root items={names} value={value} onValueChange={onChange}>
      <Field label="Branch">
        <Combobox.Input
          placeholder={branches.status === "loading" ? "Loading branches…" : "Type to filter"}
          spellCheck={false}
          autoComplete="off"
        />
      </Field>
      <Combobox.Popup>
        <ComboboxList>
          {(name: string) => (
            <ComboboxItem
              key={name}
              value={name}
              className="cursor-default px-2 py-1 data-highlighted:bg-surface-active"
            >
              {name}
            </ComboboxItem>
          )}
        </ComboboxList>
      </Combobox.Popup>
    </Combobox.Root>
  );
}
