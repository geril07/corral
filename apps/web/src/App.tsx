import { buildBoard, mostUrgentBlocked, type BoardRow } from "@corral/client/board";
import type { CorralClient } from "@corral/client/corral-client";
import { createPrefixKeymap } from "@corral/client/prefix-keymap";
import { describeError } from "@corral/client/rpc-errors";
import { describeSessionState } from "@corral/client/session-state";
import { activeAfterClose, stepActive } from "@corral/client/terminal-selection";
import {
  buildWorkspaceTree,
  currentEntry,
  entriesOf,
  resolveSelection,
  tasksInOrder,
  type Chosen,
  type Entry,
} from "@corral/client/workspace-tree";
import type {
  AgentKind,
  CreateTaskInput,
  Project,
  Session,
  SessionKind,
  Task,
  TerminalSize,
} from "@corral/protocol/rpc";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
// oxlint-disable-next-line import/no-unassigned-import -- stylesheet
import "./app.css";
import { AddProjectDialog } from "./AddProjectDialog.tsx";
import { AgentPicker } from "./AgentPicker.tsx";
import { Board } from "./Board.tsx";
import { ConnectionNotice } from "./ConnectionNotice.tsx";
import { NewTaskDialog } from "./NewTaskDialog.tsx";
import { usePrefixMode } from "./prefix-mode.ts";
import { RemoveSessionDialog } from "./RemoveSessionDialog.tsx";
import { RemoveTaskDialog } from "./RemoveTaskDialog.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { StoppedSession } from "./StoppedSession.tsx";
import { TerminalView } from "./TerminalView.tsx";

type Action =
  | "new-terminal"
  | "new-agent"
  | "stop-session"
  | "restart-session"
  | "remove-session"
  | "next-session"
  | "previous-session"
  | "new-task"
  | "remove-task"
  | "settle-task"
  | "next-task"
  | "previous-task"
  | "add-project"
  | "board"
  | "jump-blocked";

// Hardcoded until the config file (MVP step 5).
const BINDINGS: Readonly<Record<string, Action>> = {
  c: "new-terminal",
  s: "new-agent",
  x: "stop-session",
  r: "restart-session",
  "shift+x": "remove-session",
  n: "next-session",
  p: "previous-session",
  t: "new-task",
  "shift+t": "remove-task",
  d: "settle-task",
  j: "next-task",
  k: "previous-task",
  "shift+p": "add-project",
  b: "board",
  g: "jump-blocked",
};

const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };

type DialogState =
  | { kind: "add-project" }
  | { kind: "new-task"; project: Project; branches: Promise<string[]> }
  | { kind: "remove-task"; task: Task }
  | { kind: "pick-agent"; taskId: string }
  | { kind: "remove-session"; session: Session }
  | { kind: "board" };

export function App({ client, prefix }: { client: CorralClient; prefix: string }) {
  const { api } = client.connection;
  const connection = useSyncExternalStore(
    client.connection.state.subscribe,
    client.connection.state.getSnapshot,
  );
  const { projects } = useSyncExternalStore(client.projects.subscribe, client.projects.getSnapshot);
  const { tasks } = useSyncExternalStore(client.tasks.subscribe, client.tasks.getSnapshot);
  const { sessions } = useSyncExternalStore(client.sessions.subscribe, client.sessions.getSnapshot);
  const { loaded, terminals } = useSyncExternalStore(
    client.terminals.subscribe,
    client.terminals.getSnapshot,
  );
  const [chosen, setChosen] = useState<Chosen>({});
  const [dialog, setDialog] = useState<DialogState>();
  const [failure, setFailure] = useState<string>();
  const fitSize = useRef(DEFAULT_SIZE);

  const tree = buildWorkspaceTree(projects, tasks, sessions, terminals);
  const selection = resolveSelection(tree, chosen);
  const taskOrder = tasksInOrder(tree);
  const entryIds = entriesOf(tree, selection.taskId).map((entry) => entry.id);
  const current = currentEntry(tree, selection);
  const currentSession = current?.type === "session" ? current.session : undefined;
  const currentTask = taskOrder.find((task) => task.id === selection.taskId);
  const currentProject = projects.find((project) => project.id === selection.projectId);

  const choose = (next: Chosen) => setChosen((previous) => ({ ...previous, ...next }));
  const showTask = (task: Task | undefined) =>
    choose({ projectId: task?.projectId, taskId: task?.id, entryId: undefined });

  const attempt = async (work: () => Promise<void>) => {
    setFailure(undefined);
    try {
      await work();
    } catch (error) {
      setFailure(describeError(error));
    }
  };

  const startSession = (taskId: string, kind: SessionKind) =>
    attempt(async () => {
      const started = await api.sessions.start({ taskId, kind, size: fitSize.current });
      choose({ taskId, entryId: started.id });
    });

  /** A shell session in the task; outside any task, a loose terminal. */
  const createTerminal = (taskId: string | null) =>
    taskId === null
      ? attempt(async () => {
          const created = await api.terminals.create({ size: fitSize.current });
          choose({ taskId, entryId: created.id });
        })
      : startSession(taskId, "shell");

  const openAgentPicker = () => {
    if (selection.taskId === null) {
      setFailure("Select a task to start an agent in.");
      return;
    }
    setFailure(undefined);
    setDialog({ kind: "pick-agent", taskId: selection.taskId });
  };

  const pickAgent = (taskId: string, kind: AgentKind) => {
    setDialog(undefined);
    void startSession(taskId, kind);
  };

  const closeTerminal = (id: string) =>
    attempt(async () => {
      if (id === selection.entryId) {
        choose({ taskId: selection.taskId, entryId: activeAfterClose(entryIds, id) });
      }
      await api.terminals.close({ id });
    });

  const stopSession = (session: Session) =>
    attempt(async () => {
      await api.sessions.stop({ id: session.id });
    });

  const restartSession = (session: Session) =>
    attempt(async () => {
      await api.sessions.restart({ id: session.id, size: fitSize.current });
      choose({ taskId: session.taskId, entryId: session.id });
    });

  const removeSession = async (session: Session) => {
    const next = activeAfterClose(entryIds, session.id);
    await api.sessions.remove({ id: session.id });
    setDialog(undefined);
    if (session.id === selection.entryId) choose({ taskId: session.taskId, entryId: next });
  };

  const selectEntry = (entry: Entry) =>
    choose({
      taskId: entry.type === "session" ? entry.session.taskId : null,
      entryId: entry.id,
    });

  const stepEntry = (step: 1 | -1) =>
    choose({
      taskId: selection.taskId,
      entryId: stepActive(entryIds, selection.entryId, step),
    });

  const stepTask = (step: 1 | -1) => {
    const id = stepActive(
      taskOrder.map((task) => task.id),
      selection.taskId ?? undefined,
      step,
    );
    showTask(taskOrder.find((task) => task.id === id));
  };

  const board = buildBoard(tree);

  const jumpTo = (row: BoardRow) => {
    setDialog(undefined);
    choose({ projectId: row.project.id, taskId: row.task.id, entryId: row.sessionId });
  };

  const jumpToBlocked = () => {
    const row = mostUrgentBlocked(board);
    if (row) {
      setFailure(undefined);
      jumpTo(row);
    } else setFailure("No blocked sessions.");
  };

  const toggleSettle = (task: Task) =>
    attempt(async () => {
      await api.tasks.setState({
        id: task.id,
        state: task.state === "active" ? "settled" : "active",
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
    choose({ projectId: project.id, taskId: undefined, entryId: undefined });
  };

  const createTask = async (input: CreateTaskInput) => {
    const task = await api.tasks.create(input);
    setDialog(undefined);
    showTask(task);
    void startSession(task.id, "shell");
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
      else if (action === "new-agent") openAgentPicker();
      else if (action === "stop-session") {
        if (current?.type === "terminal") void closeTerminal(current.id);
        else if (currentSession?.state === "running") void stopSession(currentSession);
      } else if (action === "restart-session") {
        if (currentSession && currentSession.state !== "running")
          void restartSession(currentSession);
      } else if (action === "remove-session") {
        if (currentSession) setDialog({ kind: "remove-session", session: currentSession });
      } else if (action === "next-session") stepEntry(1);
      else if (action === "previous-session") stepEntry(-1);
      else if (action === "new-task") openNewTask();
      else if (action === "remove-task") openRemoveTask(currentTask);
      else if (action === "settle-task" && currentTask) void toggleSettle(currentTask);
      else if (action === "next-task") stepTask(1);
      else if (action === "previous-task") stepTask(-1);
      else if (action === "add-project") setDialog({ kind: "add-project" });
      else if (action === "board") setDialog({ kind: "board" });
      else if (action === "jump-blocked") jumpToBlocked();
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
            choose({ projectId: project.id, taskId: undefined, entryId: undefined })
          }
          onSelectTask={showTask}
          onSelectLoose={() => choose({ taskId: null, entryId: undefined })}
          onSelectEntry={selectEntry}
          onCloseTerminal={(id) => void closeTerminal(id)}
          onStopSession={(session) => void stopSession(session)}
          onRestartSession={(session) => void restartSession(session)}
          onRemoveSession={(session) => setDialog({ kind: "remove-session", session })}
          onToggleSettle={(task) => void toggleSettle(task)}
          onRemoveTask={openRemoveTask}
          onAddProject={() => setDialog({ kind: "add-project" })}
          onNewTask={openNewTask}
          onNewTerminal={() => void createTerminal(selection.taskId)}
          onNewAgent={openAgentPicker}
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
              prefix: c shell · s agent · x stop · r restart · X remove session · n/p session · t
              new task · T remove task · d settle · j/k task · P add project · b board · g blocked
            </output>
          ) : (
            <p className="hint">{prefix} then c s x r X n p t T d j k P b g</p>
          )}
        </footer>
      </aside>
      <main>
        {current?.terminal ? (
          <TerminalView
            key={current.terminal.id}
            client={client}
            terminal={current.terminal}
            onFit={rememberFitSize}
            exitHint={
              currentSession
                ? `${describeSessionState(currentSession).note ?? ""} Press ${prefix}, then r.`
                : undefined
            }
          />
        ) : currentSession && currentSession.state !== "running" ? (
          <StoppedSession
            key={currentSession.id}
            session={currentSession}
            prefix={prefix}
            onRestart={() => void restartSession(currentSession)}
          />
        ) : (
          loaded &&
          !currentSession && (
            <p className="empty">
              {selection.taskId === null
                ? `No terminals. Press ${prefix}, then c.`
                : `No sessions in this task. Press ${prefix}, then c for a shell or s for an agent.`}
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
      {dialog?.kind === "pick-agent" && (
        <AgentPicker
          onPick={(kind) => pickAgent(dialog.taskId, kind)}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "remove-session" && (
        <RemoveSessionDialog
          session={dialog.session}
          onRemove={() => removeSession(dialog.session)}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "board" && (
        <Board rows={board} onJump={jumpTo} onClose={() => setDialog(undefined)} />
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
