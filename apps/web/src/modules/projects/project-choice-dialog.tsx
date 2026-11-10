import type { Project } from "@corral/protocol/rpc";
import { Button, Icon, TaskDialog } from "../../common/ui/index.ts";
import { ProjectOption } from "./project-option.tsx";

/**
 * The pointer/keyboard entry to a draft when the project is not decided yet. "No project" is
 * always offered: a scratch task needs no fake project, including on an empty install.
 */
export function ProjectChoiceDialog({
  projects,
  onChoose,
  onClose,
}: {
  projects: readonly Project[];
  onChoose: (projectId: string | null) => void;
  onClose: () => void;
}) {
  return (
    <TaskDialog
      title="New task"
      description="Choose a project, or start a scratch task without one."
      layout="picker"
      onClose={onClose}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
        {projects.map((project) => (
          <Button
            key={project.id}
            type="button"
            variant="ghost"
            size="sm"
            layout="navigation"
            aria-label={project.name}
            onClick={() => onChoose(project.id)}
          >
            <ProjectOption project={project} />
          </Button>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          layout="navigation"
          aria-label="No project"
          onClick={() => onChoose(null)}
        >
          <Icon name="project" size="row" />
          <span className="min-w-0 flex-1 truncate text-left">No project</span>
          <span className="text-xs text-muted-foreground">scratch workspace</span>
        </Button>
      </div>
    </TaskDialog>
  );
}
