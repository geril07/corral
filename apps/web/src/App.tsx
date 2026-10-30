import type { CorralClient } from "@corral/client/corral-client";
import { createPrefixKeymap } from "@corral/client/prefix-keymap";
import { describeError } from "@corral/client/rpc-errors";
import { activeAfterClose, stepActive } from "@corral/client/terminal-selection";
import {
  buildWorkspaceTree,
  resolveSelection,
  tasksInOrder,
  terminalsOf,
  type Chosen,
} from "@corral/client/workspace-tree";
import type { CreateTaskInput, Project, Task, TerminalSize } from "@corral/protocol/rpc";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
// oxlint-disable-next-line import/no-unassigned-import -- stylesheet
import "./app.css";
import { AddProjectDialog } from "./AddProjectDialog.tsx";
import { ConnectionNotice } from "./ConnectionNotice.tsx";
import { NewTaskDialog } from "./NewTaskDialog.tsx";
import { usePrefixMode } from "./prefix-mode.ts";
import { RemoveTaskDialog } from "./RemoveTaskDialog.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { TerminalView } from "./TerminalView.tsx";

type Action =
  | "new-terminal"
  | "close-terminal"
  | "next-terminal"
  | "previous-terminal"
  | "new-task"
  | "remove-task"
  | "archive-task"
  | "next-task"
  | "previous-task"
  | "add-project";

// Hardcoded until the config file (MVP step 5).
const BINDINGS: Readonly<Record<string, Action>> = {
  c: "new-terminal",
  x: "close-terminal",
  n: "next-terminal",
  p: "previous-terminal",
  t: "new-task",
  "shift+t": "remove-task",
  a: "archive-task",
  j: "next-task",
  k: "previous-task",
  "shift+p": "add-project",
};

const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };

type DialogState =
  | { kind: "add-project" }
  | { kind: "new-task"; project: Project; branches: Promise<string[]> }
  | { kind: "remove-task"; task: Task };

export function App({ client, prefix }: { client: CorralClient; prefix: string }) {
  const { api } = client.connection;
  const connection = useSyncExternalStore(
    client.connection.state.subscribe,
    client.connection.state.getSnapshot,
  );
  const { projects } = useSyncExternalStore(client.projects.subscribe, client.projects.getSnapshot);
  const { tasks } = useSyncExternalStore(client.tasks.subscribe, client.tasks.getSnapshot);
  const { loaded, terminals } = useSyncExternalStore(
    client.terminals.subscribe,
    client.terminals.getSnapshot,
  );
  const [chosen, setChosen] = useState<Chosen>({});
  const [dialog, setDialog] = useState<DialogState>();
  const [failure, setFailure] = useState<string>();
  const fitSize = useRef(DEFAULT_SIZE);

  const tree = buildWorkspaceTree(projects, tasks, terminals);
  const selection = resolveSelection(tree, chosen);
  const taskOrder = tasksInOrder(tree);
  const taskTerminals = terminalsOf(tree, selection.taskId);
  const active = taskTerminals.find((terminal) => terminal.id === selection.terminalId);
  const currentTask = taskOrder.find((task) => task.id === selection.taskId);
  const currentProject = projects.find((project) => project.id === selection.projectId);

  const choose = (next: Chosen) => setChosen((previous) => ({ ...previous, ...next }));
  const showTask = (task: Task | undefined) =>
    choose({ projectId: task?.projectId, taskId: task?.id, terminalId: undefined });

  const attempt = async (work: () => Promise<void>) => {
    setFailure(undefined);
    try {
      await work();
    } catch (error) {
      setFailure(describeError(error));
    }
  };

  const createTerminal = (taskId: string | null) =>
    attempt(async () => {
      const created = await api.terminals.create({
        size: fitSize.current,
        ...(taskId !== null && { taskId }),
      });
      choose({ taskId, terminalId: created.id });
    });

  const closeTerminal = (id: string) =>
    attempt(async () => {
      if (id === selection.terminalId) {
        choose({
          taskId: selection.taskId,
          terminalId: activeAfterClose(
            taskTerminals.map((terminal) => terminal.id),
            id,
          ),
        });
      }
      await api.terminals.close({ id });
    });

  const stepTerminal = (step: 1 | -1) =>
    choose({
      taskId: selection.taskId,
      terminalId: stepActive(
        taskTerminals.map((terminal) => terminal.id),
        selection.terminalId,
        step,
      ),
    });

  const stepTask = (step: 1 | -1) => {
    const id = stepActive(
      taskOrder.map((task) => task.id),
      selection.taskId ?? undefined,
      step,
    );
    showTask(taskOrder.find((task) => task.id === id));
  };

  const toggleArchive = (task: Task) =>
    attempt(async () => {
      await api.tasks.setState({
        id: task.id,
        state: task.state === "active" ? "archived" : "active",
      });
    });

  const openNewTask = () => {
    if (!currentProject) {
      setFailure(`Add a project first: ${prefix}, then shift+p.`);
      return;
    }
    setFailure(undefined);
    setDialog({
      kind: "new-task",
      project: currentProject,
      branches: api.projects.branches({ id: currentProject.id }),
    });
  };

  const openRemoveTask = (task: Task | undefined) => {
    if (task) setDialog({ kind: "remove-task", task });
  };

  const addProject = async (path: string) => {
    const project = await api.projects.add({ path });
    setDialog(undefined);
    choose({ projectId: project.id, taskId: undefined, terminalId: undefined });
  };

  const createTask = async (input: CreateTaskInput) => {
    const task = await api.tasks.create(input);
    setDialog(undefined);
    showTask(task);
    void createTerminal(task.id);
  };

  const removeTask = async (task: Task, force: boolean) => {
    const next = taskOrder.find(
      (candidate) =>
        candidate.id ===
        activeAfterClose(
          taskOrder.map((each) => each.id),
          task.id,
        ),
    );
    await api.tasks.remove({ id: task.id, force });
    setDialog(undefined);
    if (task.id === selection.taskId) showTask(next);
  };

  const keymap = useMemo(() => createPrefixKeymap(prefix, BINDINGS), [prefix]);
  const armed = usePrefixMode(
    keymap,
    (action: Action) => {
      if (action === "new-terminal") void createTerminal(selection.taskId);
      else if (action === "close-terminal" && selection.terminalId)
        void closeTerminal(selection.terminalId);
      else if (action === "next-terminal") stepTerminal(1);
      else if (action === "previous-terminal") stepTerminal(-1);
      else if (action === "new-task") openNewTask();
      else if (action === "remove-task") openRemoveTask(currentTask);
      else if (action === "archive-task" && currentTask) void toggleArchive(currentTask);
      else if (action === "next-task") stepTask(1);
      else if (action === "previous-task") stepTask(-1);
      else if (action === "add-project") setDialog({ kind: "add-project" });
    },
    dialog === undefined,
  );

  const rememberFitSize = useCallback((size: TerminalSize) => {
    fitSize.current = size;
  }, []);

  if (connection.status === "protocol-mismatch") {
    return <ConnectionNotice state={connection} />;
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <Sidebar
          tree={tree}
          selection={selection}
          onSelectProject={(project) =>
            choose({ projectId: project.id, taskId: undefined, terminalId: undefined })
          }
          onSelectTask={showTask}
          onSelectLoose={() => choose({ taskId: null, terminalId: undefined })}
          onSelectTerminal={(terminal) =>
            choose({ taskId: terminal.taskId, terminalId: terminal.id })
          }
          onCloseTerminal={(id) => void closeTerminal(id)}
          onToggleArchive={(task) => void toggleArchive(task)}
          onRemoveTask={openRemoveTask}
          onAddProject={() => setDialog({ kind: "add-project" })}
          onNewTask={openNewTask}
          onNewTerminal={() => void createTerminal(selection.taskId)}
        />
        <footer>
          <ConnectionNotice state={connection} />
          {failure && (
            <p className="failure" role="alert">
              {failure}
            </p>
          )}
          {armed ? (
            <output aria-label="prefix mode">
              prefix: c new terminal · x close · n/p terminal · t new task · T remove task · a
              archive · j/k task · P add project
            </output>
          ) : (
            <p className="hint">{prefix} then c x n p t T a j k P</p>
          )}
        </footer>
      </aside>
      <main>
        {active ? (
          <TerminalView key={active.id} client={client} terminal={active} onFit={rememberFitSize} />
        ) : (
          loaded && (
            <p className="empty">
              {selection.taskId === null ? "No terminals." : "No terminals in this task."} Press{" "}
              {prefix}, then c.
            </p>
          )
        )}
      </main>
      {dialog?.kind === "add-project" && (
        <AddProjectDialog onAdd={addProject} onClose={() => setDialog(undefined)} />
      )}
      {dialog?.kind === "new-task" && (
        <NewTaskDialog
          project={dialog.project}
          branches={dialog.branches}
          onCreate={createTask}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "remove-task" && (
        <RemoveTaskDialog
          task={dialog.task}
          onRemove={(force) => removeTask(dialog.task, force)}
          onClose={() => setDialog(undefined)}
        />
      )}
    </div>
  );
}
