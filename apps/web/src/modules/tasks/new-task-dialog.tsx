import { describeError } from "@corral/client/rpc-errors";
import type { CreateTaskInput, Project, TaskSource } from "@corral/protocol/rpc";
import { useEffect, useRef, useState } from "react";
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
import { IssueImportSection, type ResolveIssue } from "./issue-import.tsx";

type WorkspaceKind = CreateTaskInput["workspace"]["type"];

const KINDS: readonly { kind: WorkspaceKind; label: string }[] = [
  { kind: "new-branch", label: "New branch" },
  { kind: "existing-branch", label: "Existing branch" },
  { kind: "main-worktree", label: "Main worktree" },
];

const RADIO_ROW = "flex cursor-pointer items-center gap-2";

type BranchState =
  | { status: "loading" }
  | { status: "loaded"; names: string[] }
  | { status: "failed"; error: unknown };

type Branches = BranchState & { projectId: string };

export interface NewTaskDialogProps {
  /** Every project that can take the task; the selected task's project comes first in the field. */
  projects: readonly Project[];
  /** The project to start on. */
  project: Project;
  /** The branches to pick from for "Existing branch", fetched again when the project changes. */
  loadBranches: (projectId: string) => Promise<string[]>;
  /** Resolves once the task is created; a rejection is shown in the dialog. */
  onCreate: (input: CreateTaskInput) => Promise<void>;
  /** Reads an issue only when the user asks; the project is the currently selected one. */
  onResolveIssue: (projectId: string, input: Parameters<ResolveIssue>[0], signal: AbortSignal) => Promise<TaskSource>;
  onClose: () => void;
}

export function NewTaskDialog({
  projects,
  project,
  loadBranches,
  onCreate,
  onResolveIssue,
  onClose,
}: NewTaskDialogProps) {
  const [projectId, setProjectId] = useState(project.id);
  const [title, setTitle] = useState("");
  const [source, setSource] = useState<TaskSource>();
  const [importing, setImporting] = useState(false);
  const titleRef = useRef("");
  const titleTouched = useRef(false);
  const [kind, setKind] = useState<WorkspaceKind>("new-branch");
  const [branchName, setBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [existing, setExisting] = useState<string | null>(null);
  const [branches, setBranches] = useState<Branches>({ projectId, status: "loading" });
  const attempt = useAttempt();
  /** What the form creates in now; `project` is only the project it opened on. */
  const selectedProject = projects.find((each) => each.id === projectId) ?? project;

  useEffect(() => {
    let current = true;
    loadBranches(projectId).then(
      (names) => current && setBranches({ projectId, status: "loaded", names }),
      (error: unknown) => current && setBranches({ projectId, status: "failed", error }),
    );
    return () => {
      current = false;
    };
  }, [projectId, loadBranches]);

  const chooseProject = (next: string | null) => {
    if (next === null || next === projectId) return;
    setProjectId(next);
    setExisting(null);
    setBaseBranch("");
    if (source !== undefined) {
      setSource(undefined);
      if (!titleTouched.current) {
        titleRef.current = "";
        setTitle("");
      }
    }
  };

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
  const ready =
    title.trim() !== "" && chosenWorkspace !== undefined && !attempt.pending && !importing;

  const changeTitle = (next: string) => {
    titleRef.current = next;
    titleTouched.current = true;
    setTitle(next);
  };
  const defaultTitle = (issueTitle: string) => {
    // A title the user typed stays; an empty or untouched title follows the issue.
    if (titleTouched.current && titleRef.current.trim() !== "") return;
    titleRef.current = issueTitle;
    setTitle(issueTitle);
  };

  return (
    <Dialog title="New task" description={`In project ${selectedProject.name}.`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || !chosenWorkspace) return;
          void attempt.run(() =>
            onCreate({
              projectId,
              title: title.trim(),
              ...(source === undefined ? {} : { source }),
              workspace: chosenWorkspace,
            }),
          );
        }}
      >
        <Field label="Title">
          <Input
            value={title}
            onChange={(event) => changeTitle(event.target.value)}
            autoComplete="off"
            autoFocus
          />
        </Field>
        <ProjectPicker projects={projects} value={projectId} onChange={chooseProject} />
        <IssueImportSection
          projectId={projectId}
          onResolveIssue={(input, signal) => onResolveIssue(projectId, input, signal)}
          source={source}
          onImported={setSource}
          onCleared={() => setSource(undefined)}
          onTitleDefault={defaultTitle}
          onImportingChange={setImporting}
        />
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
                placeholder={selectedProject.defaultBaseBranch}
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
          </>
        )}
        {kind === "existing-branch" && (
          <BranchPicker
            branches={branches.projectId === projectId ? branches : { status: "loading" }}
            value={existing}
            onChange={setExisting}
          />
        )}
        {kind === "main-worktree" && (
          <p className="mb-2.5 text-text-muted">
            Works directly in {selectedProject.path}, without a worktree.
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

function ProjectPicker({
  projects,
  value,
  onChange,
}: {
  projects: readonly Project[];
  value: string;
  onChange: (projectId: string | null) => void;
}) {
  const ids = projects.map((project) => project.id);
  const label = (id: string) => projects.find((project) => project.id === id)?.name ?? id;
  return (
    <Combobox.Root items={ids} value={value} onValueChange={onChange} itemToStringLabel={label}>
      <Field label="Project">
        <Combobox.Input
          aria-label="Project"
          placeholder="Search projects…"
          spellCheck={false}
          autoComplete="off"
        />
      </Field>
      <Combobox.Popup>
        <ComboboxList>
          {(id: string) => {
            const project = projects.find((each) => each.id === id);
            if (!project) return null;
            return (
              <ComboboxItem
                key={id}
                value={id}
                className="flex cursor-default items-center gap-2 px-2 py-1 data-highlighted:bg-surface-active"
              >
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                <span className="max-w-1/2 truncate text-xs text-text-muted">{project.path}</span>
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </Combobox.Popup>
    </Combobox.Root>
  );
}

function BranchPicker({
  branches,
  value,
  onChange,
}: {
  branches: BranchState;
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
          aria-label="Branch"
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
