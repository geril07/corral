import { Combobox } from "@base-ui/react/combobox";
import { describeError } from "@corral/client/rpc-errors";
import type { CreateTaskInput, Project } from "@corral/protocol/rpc";
import { useEffect, useState } from "react";
import { Modal } from "./Modal.tsx";
import { useAttempt } from "./use-attempt.ts";

type WorkspaceKind = CreateTaskInput["workspace"]["type"];

const KINDS: readonly { kind: WorkspaceKind; label: string }[] = [
  { kind: "new-branch", label: "New branch" },
  { kind: "existing-branch", label: "Existing branch" },
  { kind: "main-worktree", label: "Main worktree" },
];

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
    <Modal title="New task" description={`In project ${project.name}.`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || !chosenWorkspace) return;
          void attempt.run(() =>
            onCreate({ projectId: project.id, title: title.trim(), workspace: chosenWorkspace }),
          );
        }}
      >
        <label className="field">
          Title
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoComplete="off"
          />
        </label>
        <fieldset className="kinds">
          <legend>Workspace</legend>
          {KINDS.map((option) => (
            <label key={option.kind}>
              <input
                type="radio"
                name="workspace"
                checked={kind === option.kind}
                onChange={() => setKind(option.kind)}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        {kind === "new-branch" && (
          <>
            <label className="field">
              Branch name (optional)
              <input
                value={branchName}
                onChange={(event) => setBranchName(event.target.value)}
                placeholder="named from the title"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <label className="field">
              Base branch (optional)
              <input
                value={baseBranch}
                onChange={(event) => setBaseBranch(event.target.value)}
                placeholder={project.defaultBaseBranch}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
          </>
        )}
        {kind === "existing-branch" && (
          <BranchPicker branches={branches} value={existing} onChange={setExisting} />
        )}
        {kind === "main-worktree" && (
          <p className="hint">Works directly in {project.path}, without a worktree.</p>
        )}
        {attempt.failed && (
          <p className="form-error" role="alert">
            {describeError(attempt.error)}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!ready}>
            Create task
          </button>
        </div>
      </form>
    </Modal>
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
    return (
      <p className="form-error" role="alert">
        {describeError(branches.error)}
      </p>
    );
  }
  const names = branches.status === "loaded" ? branches.names : [];
  return (
    <Combobox.Root items={names} value={value} onValueChange={onChange}>
      <label className="field">
        Branch
        <Combobox.Input
          placeholder={branches.status === "loading" ? "Loading branches…" : "Type to filter"}
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={4}>
          <Combobox.Popup className="combobox-popup">
            <Combobox.Empty className="combobox-empty">No such branch.</Combobox.Empty>
            <Combobox.List>
              {(name: string) => (
                <Combobox.Item key={name} value={name} className="combobox-item">
                  {name}
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
