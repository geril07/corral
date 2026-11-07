import { describeError } from "@corral/client/rpc-errors";
import { searchTasks } from "@corral/client/task-search";
import type { Project, Task } from "@corral/protocol/rpc";
import { useState } from "react";
import {
  Badge,
  Button,
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
  TaskCommandDialog,
  DialogActions,
  FormError,
} from "../../common/ui/index.ts";
import { recordedBranchAccessible, recordedBranchParts } from "../tasks/index.ts";

export interface FindTaskDialogProps {
  projects: readonly Project[];
  tasks: readonly Task[];
  /** Shows the task's existing context without changing any task's state. */
  onOpen: (task: Task) => void;
  /** Reactivates a settled task; a rejection is shown in the dialog and leaves it open. */
  onContinue: (task: Task) => Promise<void>;
  onClose: () => void;
}

/**
 * Search over the tasks already watched by the client: every project, active and settled.
 * Enter or Open inspects a result; only the labelled Continue button (or Ctrl/Cmd+Enter)
 * resumes a settled task, so viewing one never restarts its sessions.
 */
export function FindTaskDialog({
  projects,
  tasks,
  onOpen,
  onContinue,
  onClose,
}: FindTaskDialogProps) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [continuing, setContinuing] = useState(false);
  const results = searchTasks(query, projects, tasks);
  const selected = results.find(({ task }) => task.id === selectedId) ?? results[0];

  const open = (task: Task) => {
    onOpen(task);
    onClose();
  };

  const continueSelected = async () => {
    if (!selected || selected.task.state !== "settled" || continuing) return;
    setFailure(undefined);
    setContinuing(true);
    try {
      await onContinue(selected.task);
    } catch (error) {
      setFailure(describeError(error));
      setContinuing(false);
      return;
    }
    onClose();
  };

  return (
    <TaskCommandDialog
      title="Find task"
      description="Every task in every project, active and settled. Enter opens one; a settled task keeps its state until you continue it."
      onClose={onClose}
    >
      <Command
        label="Tasks"
        loop
        shouldFilter={false}
        value={selected?.task.id ?? ""}
        onValueChange={(value) => {
          setSelectedId(value);
          setFailure(undefined);
        }}
      >
        <CommandInput
          aria-label="Search tasks"
          placeholder="Search title, branch or project…"
          autoFocus
          value={query}
          onValueChange={(value) => {
            setQuery(value);
            setSelectedId(undefined);
            setFailure(undefined);
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.ctrlKey || event.metaKey) &&
              selected?.task.state === "settled"
            ) {
              event.preventDefault();
              event.stopPropagation();
              void continueSelected();
            }
          }}
        />
        <CommandList>
          <CommandGroup heading="Tasks">
            {results.map(({ task, project }) => {
              const branch = recordedBranchParts(task.branch);
              return (
                <CommandItem
                  key={task.id}
                  value={task.id}
                  aria-label={[
                    task.title,
                    recordedBranchAccessible(task.branch),
                    project.name,
                    task.state === "settled" ? "settled" : undefined,
                  ]
                    .filter((part): part is string => part !== undefined)
                    .join(" — ")}
                  onSelect={() => open(task)}
                >
                  <span className="flex-1 truncate">{task.title}</span>
                  <span className="flex min-w-0 max-w-1/3 flex-col text-muted-foreground">
                    {branch.name !== undefined && (
                      <span className="min-w-0 truncate" data-recorded-name="">
                        {branch.name}
                      </span>
                    )}
                    <span className="shrink-0 text-xs" data-recorded-qualifier="">
                      {branch.qualifier}
                    </span>
                  </span>
                  <Badge variant="secondary">{project.name}</Badge>
                  {task.state === "settled" && <Badge variant="secondary">settled</Badge>}
                </CommandItem>
              );
            })}
          </CommandGroup>
          <CommandEmpty>
            {query.trim() === "" ? "No tasks to find." : "No task matches."}
          </CommandEmpty>
        </CommandList>
      </Command>
      {failure && <FormError>{failure}</FormError>}
      <DialogActions>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="outline"
          onClick={() => selected && open(selected.task)}
          disabled={!selected}
        >
          Open task
        </Button>
        {selected?.task.state === "settled" && (
          <Button variant="default" onClick={() => void continueSelected()} disabled={continuing}>
            Continue settled task
          </Button>
        )}
      </DialogActions>
    </TaskCommandDialog>
  );
}
