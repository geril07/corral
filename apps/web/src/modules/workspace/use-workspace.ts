import { hasUnseen, sessionStatus, taskStatus } from "@corral/client/agent-status";
import { buildBoard, mostUrgentBlocked, type BoardRow } from "@corral/client/board";
import { createConfigKeymap } from "@corral/client/prefix-keymap";
import { describeError } from "@corral/client/rpc-errors";
import { sessionLabels } from "@corral/client/session-labels";
import { activeAfterClose, stepActive } from "@corral/client/terminal-selection";
import {
  buildFlatSidebar,
  buildWorkspaceTree,
  currentEntry,
  entriesOf,
  flatTaskOrder,
  resolveSelection,
  taskNodeOf,
  tasksInOrder,
  type Chosen,
  type Entry,
} from "@corral/client/workspace-tree";
import { AgentKind, type ActionId } from "@corral/protocol/config";
import type {
  CreateTaskInput,
  IssueProvider,
  Project,
  Session,
  SessionKind,
  SessionView,
  Task,
  TerminalSize,
} from "@corral/protocol/rpc";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useDialogFocus } from "../../common/ui/index.ts";
import { useCorralClient, useConnection } from "../connection/index.ts";
import { useChatSession, useChatTurn } from "../chat/index.ts";
import {
  formatBinding,
  useConfig,
  usePrefixMode,
  type ActionEntry,
  type ActionTable,
} from "../keymap/index.ts";
import { describeLaunchError, type AgentLaunchChoice } from "../sessions/index.ts";
import { emptyDraft, type ComposerDraft } from "../tasks/index.ts";
import type { RenameTarget } from "./rename-dialog.tsx";
import { terminalLabel } from "./sidebar.tsx";
import { useSidebarMode } from "./sidebar-mode.ts";
import { useSidebarPane } from "./sidebar-pane.ts";
import {
  chosenToSearch,
  searchToChosen,
  workspaceSearchEqual,
  type WorkspaceSearch,
} from "./workspace-search.ts";

const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };

export type DialogState =
  | { kind: "add-project" }
  | { kind: "remove-task"; task: Task }
  | { kind: "task-source"; task: Task }
  | { kind: "pick-agent"; taskId: string }
  | { kind: "remove-session"; session: Session }
  | {
      kind: "switch-view";
      session: Session;
      target: SessionView;
      working: boolean;
      waiting: boolean;
    }
  | { kind: "find-task" }
  | { kind: "rename"; target: RenameTarget }
  | { kind: "command-palette" }
  | { kind: "config-problems" }
  | { kind: "chat-model" }
  | { kind: "chat-reasoning" };

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
  /**
   * The main area's new-task view (`layout.md`, **New task view**). It is also what the main area
   * shows whenever no task is selected, so it is a view, not a dialog: nothing captures the
   * keyboard, and Escape only returns to the task that was selected before.
   */
  const [composing, setComposing] = useState<{ project: Project; opened: number }>();
  /**
   * The composer's text and picks, kept here rather than in the view: a project navigation remounts
   * the composer, and the draft must outlive both that and a failed create (`new-task-draft.ts`).
   */
  const [composerDraft, setComposerDraft] = useState<ComposerDraft>(() => emptyDraft(""));
  /** How many times `prefix t` opened the composer; each open hands the keyboard to the prompt. */
  const composerOpens = useRef(0);
  const openDialog = (next: DialogState, opener?: HTMLElement) => {
    dialogFocus?.remember(opener);
    setDialog(next);
  };
  const [failure, setFailure] = useState<string>();
  /** The view a handoff in flight is opening; the main area says so instead of showing a pane. */
  const [handoff, setHandoff] = useState<SessionView>();
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
  const [sidebarMode, toggleSidebarMode] = useSidebarMode();
  const sidebar = useSidebarPane();
  // Built once here and handed to the sidebar: project mode has no flat list at all, and the
  // sidebar must not build a second one.
  const flatSidebar = sidebarMode === "flat" ? buildFlatSidebar(tree) : undefined;
  // j/k and the remove fallback follow the order the sidebar shows.
  const taskOrder = flatSidebar === undefined ? tasksInOrder(tree) : flatTaskOrder(flatSidebar);
  const entryIds = entriesOf(tree, selection.taskId).map((entry) => entry.id);
  // Number keys name sessions of the current task; a group of loose terminals has none.
  const sessionEntries = selection.taskId === null ? [] : entriesOf(tree, selection.taskId);
  const current = currentEntry(tree, selection);
  const currentSession = current?.type === "session" ? current.session : undefined;
  // The chat of the selected session, when it is a running chat view; its turn drives the abort
  // action without subscribing the workspace to every streamed delta.
  const chat = useChatSession(client, currentSession);
  const chatTurn = useChatTurn(chat?.store);
  // `chat.capabilities`: which agents this server build can show as chat (goal D7). One store
  // answers both the handoff offer and the composer's view control, and `loaded` lets the offer
  // wait instead of claiming no driver before the server has spoken.
  const chatCapabilities = useSyncExternalStore(
    client.chatCapabilities.subscribe,
    client.chatCapabilities.getSnapshot,
  );
  const chatDrivers = chatCapabilities.drivers;
  const currentTaskNode =
    selection.taskId === null ? undefined : taskNodeOf(tree, selection.taskId);
  const currentTask = currentTaskNode?.task;
  const currentProject = projects.find((project) => project.id === selection.projectId);
  const currentTaskProject = projects.find((project) => project.id === currentTask?.projectId);
  // Session names and tabs read from the same source, so a renamed session keeps its tab name.
  const currentSessionLabels = sessionLabels(
    currentTaskNode?.sessions.map((entry) => entry.session) ?? [],
  );

  // The server owns `seenAt`, so opening a task or watching its status change clears the same
  // completion on every client. One mark per update: the next watched task carries the new time.
  const selectedNode = selection.taskId === null ? undefined : taskNodeOf(tree, selection.taskId);
  const selectedStatus = selectedNode
    ? taskStatus(selectedNode.sessions.map((entry) => entry.session))?.status
    : undefined;
  const seenRequest = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (selectedNode === undefined || !hasUnseen(selectedNode.task, selectedStatus)) return;
    const key = [
      selectedNode.task.id,
      selectedNode.task.seenAt ?? "never",
      selectedStatus?.updatedAt,
    ].join(":");
    if (seenRequest.current === key) return;
    seenRequest.current = key;
    client.connection.api.tasks.markSeen({ id: selectedNode.task.id }).catch(() => {
      // A refused or dropped mark is retried at the next selection or status change.
      seenRequest.current = undefined;
    });
  }, [client, selectedNode, selectedStatus]);

  const choose = (next: Chosen) => {
    const merged = { ...chosenRef.current, ...next };
    chosenRef.current = merged;
    setChosen(merged);
    // Picking a task (or a loose terminal) leaves the composer; Escape has nothing to undo then.
    setComposing(undefined);
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
    if (!AgentKind.options.some((kind) => config.agents[kind].enabled.value)) {
      setFailure("Every agent is disabled in the config file.");
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

  /**
   * What `prefix v` can do for a session: the view it moves to, or why it cannot move. Only an
   * agent whose chat driver this build has can live in both views, and the answer is the server's
   * (`chat.capabilities`).
   */
  const viewHandoff = (
    session: Session | undefined,
  ): { target: SessionView } | { reason: string } => {
    if (session === undefined) return { reason: "Select an agent session." };
    if (handoff !== undefined) return { reason: "This session is switching views now." };
    if (session.kind === "shell") return { reason: "A shell runs in a terminal only." };
    if (!chatCapabilities.loaded) return { reason: "Waiting for the server's chat drivers." };
    if (!chatCapabilities.drivers.includes(session.kind))
      return { reason: `The ${session.kind} agent has no chat driver in this build.` };
    return { target: session.view === "chat" ? "terminal" : "chat" };
  };

  /**
   * Whether the selected agent is busy. A chat turn is the contract's own state; a terminal's
   * comes from the status its program reports, where `blocked` is a request waiting for the user.
   */
  const agentBusy = (session: Session) => {
    if (session.view === "chat") {
      return {
        working: chatTurn === "working",
        waiting:
          chat?.store
            .getSnapshot()
            .items.some((item) => item.kind === "user-request" && item.status === "pending") ??
          false,
      };
    }
    const state = sessionStatus(session)?.state;
    return { working: state === "working" || state === "blocked", waiting: state === "blocked" };
  };

  /**
   * Hands the session over: the main area steps aside while the server stops one frontend and
   * starts the other on the same agent session, so no pane shows a half-switched session.
   */
  const switchView = async (session: Session, target: SessionView) => {
    setHandoff(target);
    try {
      await api.sessions.setView({ id: session.id, view: target, size: fitSize.current });
      choose({ taskId: session.taskId, entryId: session.id });
    } finally {
      setHandoff(undefined);
    }
  };

  /** A busy agent is asked about first: the handoff aborts its turn and cancels what it waits on. */
  const requestSwitchView = (session: Session) => {
    const offered = viewHandoff(session);
    if (!("target" in offered)) return;
    const busy = agentBusy(session);
    if (busy.working || busy.waiting) {
      openDialog({
        kind: "switch-view",
        session,
        target: offered.target,
        working: busy.working,
        waiting: busy.waiting,
      });
      return;
    }
    void attempt(() => switchView(session, offered.target));
  };

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

  const openRenameEntry = (entry: Entry, opener?: HTMLElement) =>
    openDialog(
      {
        kind: "rename",
        target: {
          type: entry.type,
          id: entry.type === "terminal" ? entry.terminal.id : entry.session.id,
          name: displayedName(entry),
          value: (entry.type === "terminal" ? entry.terminal.label : entry.session.label) ?? "",
        },
      },
      opener,
    );

  const openRenameTask = (task: Task | undefined, opener?: HTMLElement) => {
    if (task) {
      openDialog(
        {
          kind: "rename",
          target: { type: "task", id: task.id, name: task.title, value: task.title },
        },
        opener,
      );
    }
  };

  const renameEntry = async (target: RenameTarget, name: string | null) => {
    if (target.type === "task") {
      if (name !== null) await api.tasks.rename({ id: target.id, title: name });
    } else if (target.type === "terminal")
      await api.terminals.setLabel({ id: target.id, label: name });
    else await api.sessions.setLabel({ id: target.id, label: name });
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

  /** The n-th session of the current task in sidebar order; disabled when the task has fewer. */
  const goToSession = (number: number): ActionEntry => {
    const entry = sessionEntries[number - 1];
    return {
      label: `Go to session ${number}`,
      group: "Sessions",
      enabled: entry !== undefined,
      run: () => {
        if (entry) selectEntry(entry);
      },
    };
  };

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

  /**
   * `prefix t` and the sidebar's buttons show the new-task view; `project` names the group whose
   * "+" was used. Without any project there is nowhere to create a task (`layout.md`, **Empty
   * states**), so the failure says how to add one.
   */
  const openNewTask = (project?: Project) => {
    const target = project ?? currentTaskProject ?? currentProject ?? projects[0];
    if (!target) {
      const addProject = formatBinding(config, "add-project");
      setFailure(
        addProject === "unbound" ? "Add a project first." : `Add a project first: ${addProject}.`,
      );
      return;
    }
    setFailure(undefined);
    composerOpens.current += 1;
    setComposing({ project: target, opened: composerOpens.current });
  };
  /** Escape in the composer: the selection it covered is still there and comes back. */
  const closeNewTask = () => setComposing(undefined);
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
  const openTaskSource = (task: Task, opener?: HTMLElement) =>
    openDialog({ kind: "task-source", task }, opener);

  const addProject = async (path: string) => {
    const project = await api.projects.add({ path });
    setDialog(undefined);
    choose({ projectId: project.id, taskId: undefined, entryId: undefined });
  };

  const createTask = async (input: CreateTaskInput) => {
    const task = await api.tasks.create(input);
    setDialog(undefined);
    // The task owns the draft now; the next composer starts empty in the task's project.
    setComposerDraft(emptyDraft(task.projectId));
    // The task's primary session is where the prompt went, when the composer named an agent; a
    // task created without one stays empty until the user adds a session (design.md, **Domain
    // model → Task → Creation**). Creating a task starts no shell.
    choose({
      projectId: task.projectId,
      taskId: task.id,
      entryId: task.primarySessionId ?? undefined,
    });
  };

  const resolveIssue = (
    projectId: string,
    input: { url: string; provider?: IssueProvider | undefined },
    signal: AbortSignal,
  ) =>
    api.projects.resolveIssue(
      {
        projectId,
        url: input.url,
        ...(input.provider === undefined ? {} : { provider: input.provider }),
      },
      { signal },
    );

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
      // Every agent disabled in `[agents]` leaves nothing to start.
      enabled:
        selection.taskId !== null &&
        AgentKind.options.some((kind) => config.agents[kind].enabled.value),
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
    "abort-turn": {
      label: "Abort the working turn",
      group: "Sessions",
      enabled: chat !== undefined && chatTurn === "working",
      run: () => void attempt(() => chat?.abort() ?? Promise.resolve()),
    },
    "change-model": {
      label: "Change the chat model",
      group: "Sessions",
      enabled: chat !== undefined,
      run: () => openDialog({ kind: "chat-model" }),
    },
    "change-reasoning": {
      label: "Change the reasoning level",
      group: "Sessions",
      enabled: chat !== undefined,
      run: () => openDialog({ kind: "chat-reasoning" }),
    },
    "switch-view": (() => {
      const offered = viewHandoff(currentSession);
      return {
        label: "target" in offered ? `Switch to ${offered.target}` : "Switch view",
        group: "Sessions",
        enabled: "target" in offered,
        ...("reason" in offered ? { reason: offered.reason } : {}),
        run: () => {
          if (currentSession) requestSwitchView(currentSession);
        },
      };
    })(),
    "session-1": goToSession(1),
    "session-2": goToSession(2),
    "session-3": goToSession(3),
    "session-4": goToSession(4),
    "session-5": goToSession(5),
    "session-6": goToSession(6),
    "session-7": goToSession(7),
    "session-8": goToSession(8),
    "session-9": goToSession(9),
    "new-task": {
      label: "New task",
      group: "Tasks",
      enabled: projects.length > 0,
      run: () => openNewTask(),
    },
    "remove-task": {
      label: "Remove task",
      group: "Tasks",
      enabled: currentTask !== undefined,
      run: () => openRemoveTask(currentTask),
    },
    "rename-task": {
      label: "Rename task",
      group: "Tasks",
      enabled: currentTask !== undefined,
      run: () => openRenameTask(currentTask),
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
    "sidebar-mode": {
      label: "Toggle sidebar mode",
      group: "Navigation",
      enabled: true,
      run: toggleSidebarMode,
    },
    "toggle-sidebar": {
      label: "Toggle sidebar",
      group: "Navigation",
      enabled: true,
      run: sidebar.toggle,
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
    flatSidebar,
    loaded,
    current,
    currentSession,
    chat,
    chatDrivers,
    handoff,
    currentTask,
    currentTaskNode,
    currentTaskProject,
    currentSessionLabels,
    sidebar,
    taskOrder,
    board,
    dialog,
    composing,
    composerDraft,
    setComposerDraft,
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
    switchView,
    removeSession,
    openRenameEntry,
    openRenameTask,
    renameEntry,
    selectEntry,
    jumpTo,
    toggleSettle,
    openNewTask,
    closeNewTask,
    loadBranches,
    openRemoveTask,
    openRemoveSession,
    openTaskSource,
    openAddProject,
    openPalette,
    openFindTask,
    openConfigProblems,
    addProject,
    createTask,
    resolveIssue,
    removeTask,
    setDialog,
  };
}
