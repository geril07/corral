import { describeError } from "@corral/client/rpc-errors";
import type { Project } from "@corral/protocol/rpc";
import { useMemo, useState, type ComponentProps } from "react";
import {
  Button,
  Hint,
  Icon,
  PickerAutocomplete,
  PickerToastProvider,
  TaskDialog,
  usePickerToast,
} from "../../common/ui/index.ts";

/** The sentinel item "No project" joins the same list as the projects; project ids are hex. */
const NO_PROJECT = "__no_project__";

export interface ProjectChoiceDialogProps {
  projects: readonly Project[];
  onChoose: (projectId: string | null) => void;
  /** Pins or unpins a project; the `projects.watch` update carries the new state back. */
  onSetPinned: (id: string, pinned: boolean) => Promise<void>;
  onClose: () => void;
  /** Lets a composer return the keyboard to its prompt instead of the trigger that opened this. */
  finalFocus?: ComponentProps<typeof TaskDialog>["finalFocus"];
}

/**
 * The pointer/keyboard entry to a draft when the project is not decided yet. "No project" is
 * always offered: a scratch task needs no fake project, including on an empty install. The
 * composer's project name opens this same picker, pins included.
 */
export function ProjectChoiceDialog({
  projects,
  onChoose,
  onSetPinned,
  onClose,
  finalFocus,
}: ProjectChoiceDialogProps) {
  return (
    <PickerToastProvider>
      <TaskDialog
        title="New task"
        description="Choose a project, or start a scratch task without one."
        layout="path-picker"
        showCloseButton={false}
        onClose={onClose}
        finalFocus={finalFocus}
      >
        <ProjectChoiceList
          projects={projects}
          onChoose={onChoose}
          onSetPinned={onSetPinned}
          onClose={onClose}
        />
      </TaskDialog>
    </PickerToastProvider>
  );
}

function ProjectChoiceList({ projects, onChoose, onSetPinned, onClose }: ProjectChoiceDialogProps) {
  const [query, setQuery] = useState("");
  const toast = usePickerToast();
  // The server sends the stored list in its own order; pinning only adds state, so the picker
  // sorts the one list it already has. Pinned projects first, otherwise the server's order.
  const ordered = useMemo(
    () =>
      projects.toSorted(
        (left, right) => Number(right.pinnedAt !== null) - Number(left.pinnedAt !== null),
      ),
    [projects],
  );
  const byId = new Map(ordered.map((project) => [project.id, project]));
  const labelOf = (item: string): string => {
    if (item === NO_PROJECT) return "No project";
    const project = byId.get(item);
    return project === undefined ? "" : `${project.name} ${project.path}`;
  };
  const matches = (item: string, value: string) =>
    item === NO_PROJECT || labelOf(item).toLowerCase().includes(value.trim().toLowerCase());
  const items = [NO_PROJECT, ...ordered.map((project) => project.id)];
  const choose = (item: string) => onChoose(item === NO_PROJECT ? null : item);
  const setPinned = (project: Project, pinned: boolean) => {
    void onSetPinned(project.id, pinned).catch((error: unknown) => {
      // A failed pin changes nothing locally: the list keeps the last state the server confirmed.
      toast.add({
        id: `project-pin-${project.id}`,
        title: pinned ? "Could not pin project" : "Could not unpin project",
        description: describeError(error),
        type: "error",
      });
    });
  };
  return (
    <PickerAutocomplete
      label="Projects"
      inputLabel="Search projects"
      placeholder="Search projects"
      items={items}
      query={query}
      onQueryChange={setQuery}
      filter={matches}
      itemToStringValue={labelOf}
      itemLabel={(item) => (item === NO_PROJECT ? "No project" : (byId.get(item)?.name ?? ""))}
      renderItem={(item) => {
        if (item === NO_PROJECT) return <NoProjectRow />;
        const project = byId.get(item);
        if (project === undefined) return null;
        return (
          <ProjectRow project={project} onSetPinned={(pinned) => setPinned(project, pinned)} />
        );
      }}
      onChoose={choose}
      onEnter={(active) => {
        if (active !== undefined) choose(active);
      }}
      onClose={onClose}
    />
  );
}

function NoProjectRow() {
  return (
    <>
      <Icon name="no-project" />
      <span className="min-w-0 flex-1 truncate text-left">No project</span>
    </>
  );
}

function ProjectRow({
  project,
  onSetPinned,
}: {
  project: Project;
  onSetPinned: (pinned: boolean) => void;
}) {
  return (
    <>
      <Icon name="project" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="truncate">{project.name}</span>
        <span className="truncate text-xs text-muted-foreground">{project.path}</span>
      </span>
      <span className="flex shrink-0 items-center opacity-0 group-focus-within/picker-row:opacity-100 group-hover/picker-row:opacity-100">
        <PinAction project={project} onSetPinned={onSetPinned} />
      </span>
    </>
  );
}

function PinAction({
  project,
  onSetPinned,
}: {
  project: Project;
  onSetPinned: (pinned: boolean) => void;
}) {
  const pinned = project.pinnedAt !== null;
  const label = pinned ? "Unpin" : "Pin";
  return (
    <Hint content={label}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`${label} ${project.name}`}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onSetPinned(!pinned);
        }}
      >
        <Icon name={pinned ? "unpin" : "pin"} size="row" />
      </Button>
    </Hint>
  );
}
