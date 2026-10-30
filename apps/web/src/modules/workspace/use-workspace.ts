import { buildBoard, mostUrgentBlocked, type BoardRow } from "@corral/client/board";
import { createPrefixKeymap } from "@corral/client/prefix-keymap";
import { describeError } from "@corral/client/rpc-errors";
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
import { useCorralClient, useConnection } from "../connection/index.ts";
import { BINDINGS, usePrefix, usePrefixMode, type Action } from "../keymap/index.ts";
import { chosenToSearch, searchToChosen, type WorkspaceSearch } from "./workspace-search.ts";

const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };

export type DialogState =
  | { kind: "add-project" }
  | { kind: "new-task"; project: Project; branches: Promise<string[]> }
  | { kind: "remove-task"; task: Task }
  | { kind: "pick-agent"; taskId: string }
  | { kind: "remove-session"; session: Session };

interface UseWorkspaceOptions {
  search: WorkspaceSearch;
  onChange: (search: WorkspaceSearch) => void;
  onOpenBoard: (search: WorkspaceSearch) => void;
}

/** The workspace's state and actions, wired to the client stores and the route's search params. */
export function useWorkspace({ search, onChange, onOpenBoard }: UseWorkspaceOptions) {
  const client = useCorralClient();
  const prefix = usePrefix();
  const { api } = client.connection;
  const connection = useConnection();
  const { projects } = useSyncExternalStore(client.projects.subscribe, client.projects.getSnapshot);
  const { tasks } = useSyncExternalStore(client.tasks.subscribe, client.tasks.getSnapshot);
  const { sessions } = useSyncExternalStore(client.sessions.subscribe, client.sessions.getSnapshot);
  const { loaded, terminals } = useSyncExternalStore(
    client.terminals.subscribe,
    client.terminals.getSnapshot,
  );
  const [chosen, setChosen] = useState<Chosen>(() => searchToChosen(search));
  const chosenRef = useRef(chosen);
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

  const choose = (next: Chosen) => {
    const merged = { ...chosenRef.current, ...next };
    chosenRef.current = merged;
    setChosen(merged);
    onChange(chosenToSearch(merged));
  };
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
      else if (action === "board") onOpenBoard(chosenToSearch(chosenRef.current));
      else if (action === "jump-blocked") jumpToBlocked();
    },
    dialog === undefined,
  );

  const rememberFitSize = useCallback((size: TerminalSize) => {
    fitSize.current = size;
  }, []);

  return {
    client,
    prefix,
    connection,
    tree,
    selection,
    loaded,
    current,
    currentSession,
    taskOrder,
    board,
    dialog,
    failure,
    armed,
    rememberFitSize,
    choose,
    showTask,
    createTerminal,
    openAgentPicker,
    pickAgent,
    closeTerminal,
    stopSession,
    restartSession,
    removeSession,
    selectEntry,
    jumpTo,
    toggleSettle,
    openNewTask,
    openRemoveTask,
    addProject,
    createTask,
    removeTask,
    setDialog,
  };
}
