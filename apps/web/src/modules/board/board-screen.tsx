import { buildBoard, type BoardRow } from "@corral/client/board";
import { buildWorkspaceTree } from "@corral/client/workspace-tree";
import { useSyncExternalStore } from "react";
import { useCorralClient } from "../connection/index.ts";
import { chosenToSearch } from "../workspace/index.ts";
import { Board } from "./board.tsx";

/** The board route: all active tasks over the live stores. */
export function BoardScreen({
  onClose,
  onJump,
}: {
  onClose: () => void;
  onJump: (search: ReturnType<typeof chosenToSearch>) => void;
}) {
  const client = useCorralClient();
  const { projects } = useSyncExternalStore(client.projects.subscribe, client.projects.getSnapshot);
  const { tasks } = useSyncExternalStore(client.tasks.subscribe, client.tasks.getSnapshot);
  const { sessions } = useSyncExternalStore(client.sessions.subscribe, client.sessions.getSnapshot);
  const { terminals } = useSyncExternalStore(
    client.terminals.subscribe,
    client.terminals.getSnapshot,
  );
  const rows = buildBoard(buildWorkspaceTree(projects, tasks, sessions, terminals));

  const jump = (row: BoardRow) =>
    onJump(
      chosenToSearch({ projectId: row.project.id, taskId: row.task.id, entryId: row.sessionId }),
    );

  return <Board rows={rows} onJump={jump} onClose={onClose} />;
}
