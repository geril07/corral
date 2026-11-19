import { useMemo, useState, type ComponentProps } from "react";
import {
  PickerAutocomplete,
  TaskDialog,
  VisualTaskStatus,
  type VisualTaskRow,
} from "../../common/ui/index.ts";
import { searchTasks } from "./task-search.ts";

export interface FindTaskDialogProps {
  /** The sidebar's rows, active first: the finder searches what the client already watches. */
  rows: readonly VisualTaskRow[];
  onOpen: (id: string) => void;
  /** The opener when the finder is cancelled; choosing a task lets its pane take the keyboard. */
  finalFocus?: ComponentProps<typeof TaskDialog>["finalFocus"];
  onClose: () => void;
}

/**
 * The task finder: the picker frame — one field, a `Tasks` label, a scrolling list — over the same
 * rows the sidebar shows, so a settled row opens as it is and starting work in it is what makes it
 * active (#277). Every visible fact (title, project, branch, state) finds its task, locally.
 */
export function FindTaskDialog({ rows, onOpen, finalFocus, onClose }: FindTaskDialogProps) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchTasks(query, rows), [query, rows]);

  const open = (row: VisualTaskRow) => {
    onOpen(row.id);
    onClose();
  };

  return (
    <TaskDialog
      title="Find task"
      layout="path-picker"
      showCloseButton={false}
      finalFocus={finalFocus}
      onClose={onClose}
    >
      <PickerAutocomplete
        label="Tasks"
        inputLabel="Search tasks"
        placeholder="Search tasks…"
        autoHighlight="always"
        items={results}
        query={query}
        onQueryChange={setQuery}
        filter={null}
        itemKey={(row) => row.id}
        itemToStringValue={(row) => row.title}
        itemLabel={taskLabel}
        renderItem={(row) => <TaskRow row={row} />}
        onChoose={open}
        onClose={onClose}
        empty={results.length === 0 ? "No results found" : undefined}
      />
    </TaskDialog>
  );
}

function TaskRow({ row }: { row: VisualTaskRow }) {
  const context = [row.project, row.copyBranch, row.settled === true ? "settled" : undefined]
    .filter((part) => part !== undefined)
    .join(" · ");
  return (
    <>
      <span className="visual-project-avatar" aria-hidden="true">
        {row.projectInitial}
      </span>
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate">{row.title}</span>
        <span className="truncate text-xs text-muted-foreground">{context}</span>
      </span>
      {row.status !== undefined && <VisualTaskStatus status={row.status} showTime={false} />}
      {row.activityAge !== undefined && (
        <span
          className="min-w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums"
          title={
            row.activityAt === undefined ? undefined : new Date(row.activityAt).toLocaleString()
          }
        >
          {row.activityAge}
        </span>
      )}
    </>
  );
}

/** The row's accessible name spells out the facts the visual row shows compactly. */
function taskLabel(row: VisualTaskRow): string {
  return [
    row.title,
    row.copyBranch === undefined ? undefined : `branch ${row.copyBranch}`,
    row.project,
    row.settled === true ? "settled" : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" — ");
}
