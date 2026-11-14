import { searchTasks } from "@corral/client/task-search";
import type { Project, Task } from "@corral/protocol/rpc";
import { useState } from "react";
import {
  Badge,
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
  TaskCommandDialog,
} from "../../common/ui/index.ts";
import { recordedBranchAccessible, recordedBranchParts } from "../tasks/index.ts";

export interface FindTaskDialogProps {
  projects: readonly Project[];
  tasks: readonly Task[];
  /** Shows the task's existing context without changing any task's state. */
  onOpen: (task: Task) => void;
  onClose: () => void;
}

/**
 * The command palette over the tasks already watched by the client: one field, one grouped
 * list, no title, description or footer actions. Enter opens the highlighted task, and a
 * settled one opens as it is — starting work in it is what makes it active (#277).
 */
export function FindTaskDialog({ projects, tasks, onOpen, onClose }: FindTaskDialogProps) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const results = searchTasks(query, projects, tasks);
  const selected = results.find(({ task }) => task.id === selectedId) ?? results[0];

  const open = (task: Task) => {
    onOpen(task);
    onClose();
  };

  return (
    <TaskCommandDialog title="Find task" onClose={onClose}>
      <Command
        label="Tasks"
        loop
        shouldFilter={false}
        value={selected?.task.id ?? ""}
        onValueChange={setSelectedId}
      >
        <CommandInput
          aria-label="Search tasks"
          placeholder="Search tasks…"
          autoFocus
          value={query}
          onValueChange={(value) => {
            setQuery(value);
            setSelectedId(undefined);
          }}
        />
        <CommandList variant="fixed">
          <CommandGroup heading="Tasks">
            {results.map(({ task, project }) => {
              // A task created without a branch is still findable; the qualifier says so.
              const recordedBranch = task.branch ?? "HEAD";
              const branch = recordedBranchParts(recordedBranch);
              const projectName = project?.name ?? "No project";
              return (
                <CommandItem
                  key={task.id}
                  value={task.id}
                  aria-label={[
                    task.title,
                    recordedBranchAccessible(recordedBranch),
                    projectName,
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
                  <Badge variant="secondary">{projectName}</Badge>
                  {task.state === "settled" && <Badge variant="secondary">settled</Badge>}
                </CommandItem>
              );
            })}
          </CommandGroup>
          <CommandEmpty>No results found</CommandEmpty>
        </CommandList>
      </Command>
    </TaskCommandDialog>
  );
}
