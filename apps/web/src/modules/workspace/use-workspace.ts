import { buildBoard, mostUrgentBlocked, type BoardRow } from "@corral/client/board";
import { createConfigKeymap } from "@corral/client/prefix-keymap";
import { describeError } from "@corral/client/rpc-errors";
import { sessionLabels } from "@corral/client/session-labels";
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
  CreateTaskInput,
  Project,
  Session,
  SessionKind,
  Task,
  TerminalSize,
} from "@corral/protocol/rpc";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useDialogFocus } from "../../common/ui/index.ts";
import { useCorralClient, useConnection } from "../connection/index.ts";
import { formatBinding, useConfig, usePrefixMode, type ActionTable } from "../keymap/index.ts";
import { describeLaunchError, type AgentLaunchChoice } from "../sessions/index.ts";
import type { RenameTarget } from "./rename-entry-dialog.tsx";
import { terminalLabel } from "./sidebar.tsx";
import {
  chosenToSearch,
  searchToChosen,
  workspaceSearchEqual,
  type WorkspaceSearch,
} from "./workspace-search.ts";

const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };

export type DialogState =
  | { kind: "add-project" }
  | { kind: "new-task"; project: Project }
  | { kind: "remove-task"; task: Task }
  | { kind: "pick-agent"; taskId: string }
  | { kind: "remove-session"; session: Session }
  | { kind: "find-task" }
  | { kind: "rename-entry"; target: RenameTarget }
  | { kind: "command-palette" }
  | { kind: "config-problems" };

interface UseWorkspaceOptions {
  search: WorkspaceSearch;
  onChange: (search: WorkspaceSearch) => void;
  onOpenBoard: (search: WorkspaceSearch) => void;
  onOpenSettings: (search: WorkspaceSearch) => void;
}

/** The workspace's state and actions, wired to the client stores and the route's search params. */
export function useWorkspace({
  search,
  onChange,
  onOpenBoard,
  onOpenSettings,
}: UseWorkspaceOptions) {
  const client = useCorralClient();
  const dialogFocus = useDialogFocus();
  const { config, profiles } = useConfig();
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
  const routeSearchRef = useRef(search);
  const [dialog, setDialog] = useState<DialogState>();
  const openDialog = (next: DialogState, opener?: HTMLElement) => {
    dialogFocus?.remember(opener);
    setDialog(next);
  };
  const [failure, setFailure] = useState<string>();
  const fitSize = useRef(DEFAULT_SIZE);

  // The URL is the source of truth for Back/Forward and for a route search that arrives after
  // the first render. Local choices already update the URL, so applying the echo changes nothing.
  useEffect(() => {
    if (workspaceSearchEqual(search, routeSearchRef.current)) return;
    routeSearchRef.current = search;
    const fromRoute = searchToChosen(search);
    if (workspaceSearchEqual(chosenToSearch(fromRoute), chosenToSearch(chosenRef.current))) {
      return;
    }
    chosenRef.current = fromRoute;
    setChosen(fromRoute);
  }, [search]);

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

  const openTask = (task: Task) => {
    setFailure(undefined);
    showTask(task);
  };

  /** The same reactivation lifecycle as unsettling in the sidebar; sessions then resume. */
  const continueTask = async (task: Task) => {
    await api.tasks.setState({ id: task.id, state: "active" });
    showTask(task);
  };

  const attempt = async (work: () => Promise<void>) => {
    setFailure(undefined);
    try {
      await work();
    } catch (error) {
      setFailure(describeLaunchError(error) ?? describeError(error));
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

  const openAgentPicker = (opener?: HTMLElement) => {
    if (selection.taskId === null) {
      setFailure("Select a task to start an agent in.");
      return;
    }
    setFailure(undefined);
    openDialog({ kind: "pick-agent", taskId: selection.taskId }, opener);
  };

  /** Starts the picked agent or profile; the picker keeps its draft when the server refuses it. */
  const startAgent = async (taskId: string, choice: AgentLaunchChoice) => {
    setFailure(undefined);
    const started = await api.sessions.start({
      taskId,
      kind: choice.kind,
      size: fitSize.current,
      ...(choice.profileId === undefined
        ? {}
        : {
            profileId: choice.profileId,
            ...(choice.expectedProfileRevision === undefined
              ? {}
              : { expectedProfileRevision: choice.expectedProfileRevision }),
          }),
      ...(choice.model === undefined ? {} : { model: choice.model }),
    });
    setDialog(undefined);
    choose({ taskId, entryId: started.id });
  };

  /** Settings is a route; remember the opener for focus, then leave the workspace. */
  const openSettings = (opener?: HTMLElement) => {
    dialogFocus?.remember(opener);
    onOpenSettings(chosenToSearch(chosenRef.current));
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

  /** The name the sidebar shows for the entry now; a rename dialog is titled with it. */
  const displayedName = (entry: Entry) =>
    entry.type === "terminal"
      ? terminalLabel(entry.terminal)
      : (sessionLabels(sessions.filter((each) => each.taskId === entry.session.taskId)).get(
          entry.session.id,
        ) ?? entry.session.kind);

  const openRenameEntry = (entry: Entry) =>
    openDialog({
      kind: "rename-entry",
      target: {
        type: entry.type,
        id: entry.type === "terminal" ? entry.terminal.id : entry.session.id,
        name: displayedName(entry),
        label: (entry.type === "terminal" ? entry.terminal.label : entry.session.label) ?? null,
      },
    });

  const renameEntry = async (target: RenameTarget, label: string | null) => {
    if (target.type === "terminal") await api.terminals.setLabel({ id: target.id, label });
    else await api.sessions.setLabel({ id: target.id, label });
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

  const openNewTask = (opener?: HTMLElement) => {
    if (!currentProject) {
      const addProject = formatBinding(config, "add-project");
      setFailure(
        addProject === "unbound" ? "Add a project first." : `Add a project first: ${addProject}.`,
      );
      return;
    }
    setFailure(undefined);
    openDialog({ kind: "new-task", project: currentProject }, opener);
  };
  const loadBranches = useCallback(
    (projectId: string) => api.projects.branches({ id: projectId }),
    [api],
  );
  const openAddProject = (opener?: HTMLElement) => openDialog({ kind: "add-project" }, opener);
  const openPalette = (opener?: HTMLElement) => openDialog({ kind: "command-palette" }, opener);
  const openFindTask = (opener?: HTMLElement) => openDialog({ kind: "find-task" }, opener);
  const openConfigProblems = (opener?: HTMLElement) =>
    openDialog({ kind: "config-problems" }, opener);

  const openRemoveTask = (task: Task | undefined) => {
    if (task) openDialog({ kind: "remove-task", task });
  };
  const openRemoveSession = (session: Session) => openDialog({ kind: "remove-session", session });

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
    "rename-session": {
      label: "Rename session",
      group: "Sessions",
      enabled: current !== undefined,
      run: () => {
        if (current) openRenameEntry(current);
      },
    },
    "remove-session": {
      label: "Remove session",
      group: "Sessions",
      enabled: currentSession !== undefined,
      run: () => {
        if (currentSession) openDialog({ kind: "remove-session", session: currentSession });
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
    "find-task": {
      label: "Find task",
      group: "Tasks",
      enabled: true,
      run: () => openFindTask(),
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
      run: () => openAddProject(),
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
      run: () => openPalette(),
    },
    settings: {
      label: "Settings",
      group: "General",
      enabled: true,
      run: () => openSettings(),
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
    profiles,
    prefix,
    connection,
    projects,
    tasks,
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
    openTask,
    continueTask,
    createTerminal,
    openAgentPicker,
    startAgent,
    openSettings,
    closeTerminal,
    stopSession,
    restartSession,
    removeSession,
    openRenameEntry,
    renameEntry,
    selectEntry,
    jumpTo,
    toggleSettle,
    openNewTask,
    loadBranches,
    openRemoveTask,
    openRemoveSession,
    openAddProject,
    openPalette,
    openFindTask,
    openConfigProblems,
    addProject,
    createTask,
    removeTask,
    setDialog,
  };
}
