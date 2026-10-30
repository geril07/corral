import { buildBoard, mostUrgentBlocked, type BoardRow } from "@corral/client/board";
import { createConfigKeymap } from "@corral/client/prefix-keymap";
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
import type { ActionId } from "@corral/protocol/config";
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
import { formatBinding, useConfig, usePrefixMode, type ActionTable } from "../keymap/index.ts";
import { chosenToSearch, searchToChosen, type WorkspaceSearch } from "./workspace-search.ts";

const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };

export type DialogState =
  | { kind: "add-project" }
  | { kind: "new-task"; project: Project; branches: Promise<string[]> }
  | { kind: "remove-task"; task: Task }
  | { kind: "pick-agent"; taskId: string }
  | { kind: "remove-session"; session: Session }
  | { kind: "command-palette" }
  | { kind: "config-problems" };

interface UseWorkspaceOptions {
  search: WorkspaceSearch;
  onChange: (search: WorkspaceSearch) => void;
  onOpenBoard: (search: WorkspaceSearch) => void;
}

/** The workspace's state and actions, wired to the client stores and the route's search params. */
export function useWorkspace({ search, onChange, onOpenBoard }: UseWorkspaceOptions) {
  const client = useCorralClient();
  const { config } = useConfig();
  const prefix = config.keys.prefix;
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
  const taskIds = taskOrder.map((task) => task.id);
  const nextTaskId = stepActive(taskIds, selection.taskId ?? undefined, 1);
  const previousTaskId = stepActive(taskIds, selection.taskId ?? undefined, -1);

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
      const addProject = formatBinding(config, "add-project");
      setFailure(
        addProject === "unbound" ? "Add a project first." : `Add a project first: ${addProject}.`,
      );
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

  const actions: ActionTable = {
    "new-terminal": {
      label: "New terminal",
      group: "Sessions",
      enabled: true,
      run: () => void createTerminal(selection.taskId),
    },
    "new-agent": {
      label: "New agent session",
      group: "Sessions",
      enabled: selection.taskId !== null,
      run: openAgentPicker,
    },
    "stop-session": {
      label: "Stop session",
      group: "Sessions",
      enabled: current?.type === "terminal" || currentSession?.state === "running",
      run: () => {
        if (current?.type === "terminal") void closeTerminal(current.id);
        else if (currentSession?.state === "running") void stopSession(currentSession);
      },
    },
    "restart-session": {
      label: "Restart session",
      group: "Sessions",
      enabled: currentSession !== undefined && currentSession.state !== "running",
      run: () => {
        if (currentSession && currentSession.state !== "running")
          void restartSession(currentSession);
      },
    },
    "remove-session": {
      label: "Remove session",
      group: "Sessions",
      enabled: currentSession !== undefined,
      run: () => {
        if (currentSession) setDialog({ kind: "remove-session", session: currentSession });
      },
    },
    "next-session": {
      label: "Next session",
      group: "Sessions",
      enabled: entryIds.length > 1,
      run: () => stepEntry(1),
    },
    "previous-session": {
      label: "Previous session",
      group: "Sessions",
      enabled: entryIds.length > 1,
      run: () => stepEntry(-1),
    },
    "new-task": {
      label: "New task",
      group: "Tasks",
      enabled: currentProject !== undefined,
      run: openNewTask,
    },
    "remove-task": {
      label: "Remove task",
      group: "Tasks",
      enabled: currentTask !== undefined,
      run: () => openRemoveTask(currentTask),
    },
    "settle-task": {
      label: "Settle or unsettle task",
      group: "Tasks",
      enabled: currentTask !== undefined,
      run: () => {
        if (currentTask) void toggleSettle(currentTask);
      },
    },
    "next-task": {
      label: "Next task",
      group: "Tasks",
      enabled: nextTaskId !== undefined && nextTaskId !== selection.taskId,
      run: () => stepTask(1),
    },
    "previous-task": {
      label: "Previous task",
      group: "Tasks",
      enabled: previousTaskId !== undefined && previousTaskId !== selection.taskId,
      run: () => stepTask(-1),
    },
    "add-project": {
      label: "Add project",
      group: "Projects",
      enabled: true,
      run: () => setDialog({ kind: "add-project" }),
    },
    board: {
      label: "Open board",
      group: "Navigation",
      enabled: true,
      run: () => onOpenBoard(chosenToSearch(chosenRef.current)),
    },
    "jump-blocked": {
      label: "Jump to blocked session",
      group: "Navigation",
      enabled: mostUrgentBlocked(board) !== undefined,
      run: jumpToBlocked,
    },
    "command-palette": {
      label: "Command palette",
      group: "General",
      enabled: true,
      run: () => setDialog({ kind: "command-palette" }),
    },
  };

  const keymap = useMemo(() => createConfigKeymap(config), [config]);
  const armed = usePrefixMode(
    keymap,
    (action: ActionId) => actions[action].run(),
    dialog === undefined,
  );

  const rememberFitSize = useCallback((size: TerminalSize) => {
    fitSize.current = size;
  }, []);

  return {
    client,
    config,
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
    actions,
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
