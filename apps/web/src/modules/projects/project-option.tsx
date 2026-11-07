import type { Project } from "@corral/protocol/rpc";
import { useTruncatedText } from "../../common/ui/index.ts";

/** The label both the visible row and the combobox filter read: name then path, one fact. */
export function projectOptionLabel(project: Pick<Project, "name" | "path">): string {
  return `${project.name} ${project.path}`;
}

/** A project's combobox row: its name, then a bounded path line that reveals the full value. */
export function ProjectOption({ project }: { project: Pick<Project, "name" | "path"> }) {
  const { observe: observeName, clipped: nameClipped } = useTruncatedText(project.name);
  const { observe: observePath, clipped: pathClipped } = useTruncatedText(project.path);
  return (
    <>
      <span
        ref={observeName}
        className="min-w-0 flex-1 truncate"
        title={nameClipped ? project.name : undefined}
      >
        {project.name}
      </span>
      <span
        ref={observePath}
        className="max-w-1/2 min-w-0 truncate text-xs text-muted-foreground"
        title={pathClipped ? project.path : undefined}
      >
        {project.path}
      </span>
    </>
  );
}
