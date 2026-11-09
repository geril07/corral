import { describeError } from "@corral/client/rpc-errors";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useNow } from "../../common/hooks/use-now.ts";
import { useCorralClient } from "../connection/index.ts";
import { bindingOf, useConfig } from "../keymap/index.ts";
import { AddProjectDialog } from "../projects/index.ts";
import { VisualShellView } from "./visual-view.tsx";
import { buildTaskRows } from "./visual-status.ts";

/** The live shell: independent read-only stores and one safe write path (add project). */
export function VisualWorkspace({
  selectedTaskId,
  onSelectTask,
}: {
  selectedTaskId: string | null | undefined;
  onSelectTask: (id: string) => void;
}) {
  const client = useCorralClient();
  const { config } = useConfig();
  const now = useNow(30_000);
  const projects = useSyncExternalStore(client.projects.subscribe, client.projects.getSnapshot);
  const tasks = useSyncExternalStore(client.tasks.subscribe, client.tasks.getSnapshot);
  const sessions = useSyncExternalStore(client.sessions.subscribe, client.sessions.getSnapshot);
  const projectsFailure = useSyncExternalStore(
    client.projects.failure.subscribe,
    client.projects.failure.getSnapshot,
  );
  const tasksFailure = useSyncExternalStore(
    client.tasks.failure.subscribe,
    client.tasks.failure.getSnapshot,
  );
  const sessionFailure = useSyncExternalStore(
    client.sessions.failure.subscribe,
    client.sessions.failure.getSnapshot,
  );
  const [addingProject, setAddingProject] = useState(false);
  const browse = useCallback(
    (path: string, signal: AbortSignal) =>
      client.connection.api.projects.directories({ path }, { signal }),
    [client],
  );

  const rows = useMemo(
    () => buildTaskRows(projects.projects, tasks.tasks, sessions.sessions, now),
    [now, projects.projects, sessions.sessions, tasks.tasks],
  );
  const failure = projectsFailure ?? tasksFailure ?? sessionFailure;
  const binding = bindingOf(config, "toggle-sidebar");
  const prefix = config.keys.prefix;
  const shortcut = useMemo(
    () => (binding === null ? undefined : { prefix, binding }),
    [binding, prefix],
  );

  return (
    <>
      <VisualShellView
        rows={rows}
        selectedId={selectedTaskId}
        projectsLoaded={projects.loaded}
        tasksLoaded={tasks.loaded}
        failure={
          failure === undefined ? undefined : `${failure.label}: ${describeError(failure.error)}`
        }
        shortcut={shortcut}
        onSelectTask={onSelectTask}
        onAddProject={() => setAddingProject(true)}
        prefixEnabled={!addingProject}
      />
      {addingProject && (
        <AddProjectDialog
          onBrowse={browse}
          onAdd={async (path) => {
            await client.connection.api.projects.add({ path });
          }}
          onClose={() => setAddingProject(false)}
        />
      )}
    </>
  );
}
