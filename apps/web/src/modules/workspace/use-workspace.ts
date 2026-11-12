import { hasUnseen, sessionStatus, taskStatus } from "@corral/client/agent-status";
import { buildBoard, mostUrgentBlocked, type BoardRow } from "@corral/client/board";
import { chatDriverFor } from "@corral/client/chat-capabilities-store";
import { createConfigKeymap } from "@corral/client/prefix-keymap";
import { describeError, SETTLED_TASK_MESSAGE } from "@corral/client/rpc-errors";
import { sessionLabels } from "@corral/client/session-labels";
import { activeAfterClose, stepActive } from "@corral/client/terminal-selection";
import type { WatchFailure, WatchStore } from "@corral/client/watch-store";
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
  type TerminalEntry,
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
import { workspaceMissingPath } from "@corral/protocol/workspace";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useDialogFocus, useTaskFinalFocus, workspaceInput } from "../../common/ui/index.ts";
import { createChangesActions, usePullRequests, type ChangesActions } from "../changes/index.ts";
import { useCorralClient, useConnection } from "../connection/index.ts";
import { useChatSession, useChatTurn, type ChatFiles } from "../chat/index.ts";
import {
  actionAvailability,
  formatBinding,
  useConfig,
  usePrefixMode,
  type ActionEntry,
  type ActionTable,
} from "../keymap/index.ts";
import { describeLaunchError, type AgentLaunchChoice } from "../sessions/index.ts";
import { emptyDraft, workspaceGoneNotice, type ComposerDraft } from "../tasks/index.ts";
import type { RenameTarget } from "./rename-dialog.tsx";
import { terminalLabel } from "./sidebar.tsx";
import { ADD_PROJECT_BUTTON_ID, SIDEBAR_ROW_SELECTOR, sidebarRowTarget } from "./sidebar-focus.ts";
import { useSidebarMode } from "./sidebar-mode.ts";
import type { ShellFailure } from "./shell-status.tsx";
import { useSidebarPane } from "./sidebar-pane.ts";
import {
  CHANGES_ENTRY,
  changesSearch,
  chosenToSearch,
  searchToChosen,
  workspaceSearchEqual,
  type WorkspaceSearch,
} from "./workspace-search.ts";

const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };

/** A failure keeps the client's sentence, unless it is the transport's own internal voice. */
function failureText(error: unknown): string {
  const message = describeLaunchError(error) ?? describeError(error);
  return message === "not connected to the server"
    ? "The server is not connected, so the action was not sent."
    : message;
}

export type DialogState =
  | { kind: "add-project" }
  | { kind: "remove-task"; task: Task; workspaceMissing?: boolean }
  | { kind: "remove-project"; project: Project }
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
  | { kind: "connection" }
  | { kind: "chat-model" }
  | { kind: "chat-reasoning" };

interface UseWorkspaceOptions {
  active?: boolean;
  search: WorkspaceSearch;
  onChange: (search: WorkspaceSearch) => void;
  onOpenBoard: (search: WorkspaceSearch) => void;
  onOpenSettings: (search: WorkspaceSearch) => void;
}

/** One watched list's refusal, for the main area's state; `undefined` while it has not failed. */
function useWatchFailure<Snapshot>(store: WatchStore<Snapshot>): WatchFailure | undefined {
  return useSyncExternalStore(store.failure.subscribe, store.failure.getSnapshot);
}

/** The workspace's state and actions, wired to the client stores and the route's search params. */
export function useWorkspace({
  active = true,
  search,
  onChange,
  onOpenBoard,
  onOpenSettings,
}: UseWorkspaceOptions) {
  const client = useCorralClient();
  const dialogFocus = useDialogFocus();
  // Where the keyboard goes when it leaves the sidebar list, the way a route dialog returns it.
  const finalFocus = useTaskFinalFocus();
  const { config, profiles } = useConfig();
  const prefix = config.keys.prefix;
  const { api } = client.connection;
  const connection = useConnection();
  const projectsSnapshot = useSyncExternalStore(
    client.projects.subscribe,
    client.projects.getSnapshot,
  );
  const tasksSnapshot = useSyncExternalStore(client.tasks.subscribe, client.tasks.getSnapshot);
  const sessionsSnapshot = useSyncExternalStore(
    client.sessions.subscribe,
    client.sessions.getSnapshot,
  );
  const terminalsSnapshot = useSyncExternalStore(
    client.terminals.subscribe,
    client.terminals.getSnapshot,
  );
  const { projects } = projectsSnapshot;
  const { tasks } = tasksSnapshot;
  const { sessions } = sessionsSnapshot;
  const { terminals } = terminalsSnapshot;
  const projectsFailure = useWatchFailure(client.projects);
  const tasksFailure = useWatchFailure(client.tasks);
  const sessionsFailure = useWatchFailure(client.sessions);
  const terminalsFailure = useWatchFailure(client.terminals);
  // All four lists are the tree (`workspace-tree.ts`); an empty one is only empty once it has
  // arrived. A failure is a refusal, never a list of zero.
  const loaded =
    projectsSnapshot.loaded &&
    tasksSnapshot.loaded &&
    sessionsSnapshot.loaded &&
    terminalsSnapshot.loaded;
  const watchFailure = projectsFailure ?? tasksFailure ?? sessionsFailure ?? terminalsFailure;
  // Each task's changed files: the Changes tab's rows, the task header's counts and the sidebar's.
  const changes = useSyncExternalStore(client.changes.subscribe, client.changes.getSnapshot);
  const [chosen, setChosen] = useState<Chosen>(() => searchToChosen(search));
  const chosenRef = useRef(chosen);
  const routeSearchRef = useRef(search);
  const [dialog, setDialog] = useState<DialogState>();
  /**
   * The remove dialog's workspace read, kept by task. Cancel aborts it; a confirmation reads the
   * workspace again, so a stale copy or a read that failed is never turned into a silent prune.
   */
  const removeWorkspaceRead = useRef<{ taskId: string; controller: AbortController } | undefined>(
    undefined,
  );
  /**
   * The main area's new-task view (`layout.md`, **New task view**). It is also what the main area
   * shows whenever no task is selected, so it is a view, not a dialog: nothing captures the
   * keyboard, and Escape only returns to the task that was selected before.
   */
  const [composing, setComposing] = useState<{ project?: Project; opened: number }>();
  /**
   * Whether the current task shows its `Changes` tab (`layout.md`, **Changes**). It is the
   * route's `entry=changes` and deliberately not part of `Chosen`: the tab is not a session, so
   * opening it leaves the current session alone, and choosing a session closes it again.
   */
  const [changesView, setChangesView] = useState(() => search.entry === CHANGES_ENTRY);
  /**
   * The composer's text and picks, kept here rather than in the view: a project navigation remounts
   * the composer, and the draft must outlive both that and a failed create (`new-task-draft.ts`).
   */
  const [composerDraft, setComposerDraft] = useState<ComposerDraft>(() => emptyDraft(""));
  /** How many times `prefix t` opened the composer; each open hands the keyboard to the prompt. */
  const composerOpens = useRef(0);
  const openDialog = (next: DialogState, opener?: HTMLElement) => {
    // A remove that is still reading its workspace must not outlive its dialog: Cancel, Escape or
    // another dialog aborts it before the read can reach `tasks.remove`.
    removeWorkspaceRead.current?.controller.abort();
    dialogFocus?.remember(opener);
    setDialog(next);
  };
  const [failure, setFailure] = useState<ShellFailure>();
  /**
   * The view a switch in flight is opening; the main area says so instead of showing a pane. `live`
   * is a `both-live` driver's switch, which starts a client of the agent's server beside the live
   * one rather than stopping it (C1).
   */
  const [handoff, setHandoff] = useState<{ target: SessionView; live: boolean }>();
  const fitSize = useRef(DEFAULT_SIZE);

  // The URL is the source of truth for Back/Forward and for a route search that arrives after
  // the first render. Local choices already update the URL, so applying the echo changes nothing.
  useEffect(() => {
    if (workspaceSearchEqual(search, routeSearchRef.current)) return;
    routeSearchRef.current = search;
    // The tab is a view, not the selection: `fromRoute` carries the session it covers (from
    // `session`), so a reload or Back restores both the tab and the session behind it.
    setChangesView(search.entry === CHANGES_ENTRY);
    const fromRoute = searchToChosen(search);
    if (workspaceSearchEqual(chosenToSearch(fromRoute), chosenToSearch(chosenRef.current))) {
      return;
    }
    chosenRef.current = fromRoute;
    setChosen(fromRoute);
    // Back/Forward and a route that arrives after the first render are navigation too; a stale
    // failure must not outlive the selection it complained about.
    setFailure(undefined);
  }, [search]);

  const tree = buildWorkspaceTree(projects, tasks, sessions, terminals);
  /*
   * The Changes tab's write controls (C6): one action object per task, rebuilt only when the set of
   * tasks changes, because the finish bar re-reads `finish` whenever its actions change identity.
   * The pull requests linked to those tasks are read for the header and the sidebar badges and
   * refreshed on window focus and on the interval `finish-actions.ts` states.
   */
  const finishTaskIds = useMemo(
    () =>
      tree.projects
        .flatMap((project) => [...project.active, ...project.settled])
        .map((node) => node.task.id),
    [tree],
  );
  const finishTaskKey = finishTaskIds.join("\n");
  const finishActions = useMemo(() => {
    const actions = new Map<string, ChangesActions>();
    for (const id of finishTaskKey === "" ? [] : finishTaskKey.split("\n")) {
      actions.set(id, createChangesActions(client, id));
    }
    return actions;
  }, [client, finishTaskKey]);
  const pullRequests = usePullRequests(
    (taskId) => finishActions.get(taskId),
    finishTaskKey === "" ? [] : finishTaskKey.split("\n"),
  );
  const selection = resolveSelection(tree, chosen);
  const [sidebarMode, toggleSidebarMode] = useSidebarMode();
  const sidebar = useSidebarPane();
  /** Every request for the sidebar list's keyboard; each one is handled once, after its commit. */
  const [listFocusRequest, setListFocusRequest] = useState(0);
  const handledListFocus = useRef(0);
  /** Enter on the open row returns the keyboard without a remount, so it asks for one here. */
  const [workspaceFocusRequest, setWorkspaceFocusRequest] = useState(0);
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
  // The picker and both chords use one fact: a running chat session that can own the content.
  const chatPicker =
    chat !== undefined && currentSession !== undefined && currentSession.kind !== "shell"
      ? {
          chat,
          session: { ...currentSession, kind: currentSession.kind },
        }
      : undefined;
  const canShowChatPicker = chatPicker !== undefined;
  // A picker whose chat stops has nothing left to show; close it so its dialog cannot outlive it.
  useEffect(() => {
    if (canShowChatPicker) return;
    setDialog((currentDialog) =>
      currentDialog?.kind === "chat-model" || currentDialog?.kind === "chat-reasoning"
        ? undefined
        : currentDialog,
    );
  }, [canShowChatPicker]);
  // `chat.capabilities`: which agents this server build can show as chat (goal D7) and what each
  // driver declared (protocol 10). One store answers the handoff offer, the composer's view control
  // and the palette, and `loaded` lets an offer wait instead of claiming no driver before the
  // server has spoken. The view controls read the kinds; the composer reads the matched driver's
  // `followUp`, and the action a `both-live` driver needs (C1) reads `terminalView`.
  const chatCapabilities = useSyncExternalStore(
    client.chatCapabilities.subscribe,
    client.chatCapabilities.getSnapshot,
  );
  const chatDrivers = useMemo(
    () => chatCapabilities.drivers.map((driver) => driver.kind),
    [chatCapabilities.drivers],
  );
  // The selected session's driver record, once the server has answered. An absent record is not a
  // refusal: it keeps the composer's previous offer until the store reports one.
  const chatDriver = useMemo(
    () =>
      currentSession === undefined || currentSession.kind === "shell"
        ? undefined
        : chatDriverFor(chatCapabilities.drivers, currentSession.kind),
    [chatCapabilities.drivers, currentSession],
  );
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
    if (!active || selectedNode === undefined || !hasUnseen(selectedNode.task, selectedStatus))
      return;
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
  }, [active, client, selectedNode, selectedStatus]);

  const choose = useCallback(
    (next: Chosen) => {
      const merged = { ...chosenRef.current, ...next };
      chosenRef.current = merged;
      setChosen(merged);
      // Picking a task (or a loose terminal) leaves the composer; Escape has nothing to undo then.
      setComposing(undefined);
      // The failure asked for this navigation, or the user has moved on; either way it is spent.
      setFailure(undefined);
      // Any entry choice is a session choice: it also leaves the task's Changes tab.
      setChangesView(false);
      onChange(chosenToSearch(merged));
    },
    [onChange],
  );

  /**
   * `prefix w`: the sidebar list takes the keyboard, so it is shown first when hidden. The opener
   * is remembered only on the way in from outside the list, so pressing the prefix again and then
   * Escape still returns the keyboard to the task instead of leaving it on the row.
   */
  const focusSidebarList = () => {
    const activeElement = document.activeElement;
    if (
      !(activeElement instanceof HTMLElement) ||
      activeElement.closest(SIDEBAR_ROW_SELECTOR) === null
    ) {
      dialogFocus?.remember();
    }
    sidebar.show();
    setListFocusRequest((request) => request + 1);
  };

  useEffect(() => {
    if (listFocusRequest === handledListFocus.current || sidebar.hidden) return undefined;
    handledListFocus.current = listFocusRequest;
    const request = listFocusRequest;
    let frame: number | undefined;
    let cancelled = false;
    let watching = false;
    let moved = false;
    const noteMove = () => {
      moved = true;
    };
    const stopWatching = () => {
      if (!watching) return;
      watching = false;
      document.removeEventListener("pointerdown", noteMove, true);
      document.removeEventListener("keydown", noteMove, true);
    };
    // A dialog closed by the same action, such as the palette, returns the keyboard in a
    // microtask of its own; this one is queued after it so the list, not the dialog's opener, ends
    // up with the keyboard. The row is looked up after the next frame because the shown sidebar
    // measures its rows there: a clipped row gains its tooltip wrapper and is replaced, so a row
    // captured before that render would be detached and would keep the keyboard where it was.
    queueMicrotask(() => {
      if (cancelled) return;
      const origin = document.activeElement;
      // A pointer or key after the dialog's microtask is the user taking the keyboard back, even
      // when it lands on the same element the action started from.
      watching = true;
      document.addEventListener("pointerdown", noteMove, true);
      document.addEventListener("keydown", noteMove, true);
      frame = requestAnimationFrame(() => {
        stopWatching();
        if (cancelled || moved || handledListFocus.current !== request) return;
        const focused = document.activeElement;
        // The opener is gone, or another live element has the keyboard: the user moved on.
        if (!(origin instanceof HTMLElement) || !origin.isConnected) return;
        if (focused instanceof HTMLElement && focused !== document.body && focused !== origin)
          return;
        const target = sidebarRowTarget() ?? document.getElementById(ADD_PROJECT_BUTTON_ID);
        if (target?.isConnected) target.focus();
      });
    });
    return () => {
      cancelled = true;
      stopWatching();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [listFocusRequest, sidebar.hidden]);

  // Enter on the row that is already open mounts no pane, so the selected view's input is handed
  // the keyboard here, after the activation's commit, the way a pane mount would.
  useEffect(() => {
    if (workspaceFocusRequest === 0) return;
    workspaceInput()?.focus();
  }, [workspaceFocusRequest]);

  const leaveSidebarList = () => finalFocus()?.focus();
  const returnToWorkspace = () => setWorkspaceFocusRequest((request) => request + 1);

  /**
   * Opens the task's `Changes` tab: the route says `entry=changes` and the current session, the
   * terminal in the main area and the chat store stay exactly as they were.
   */
  const openChanges = () => {
    if (selection.taskId === null) return;
    setFailure(undefined);
    setComposing(undefined);
    setChangesView(true);
    onChange(changesSearch(chosenRef.current));
  };

  // Chat's local links (`docs/design.md`): the workspace is the allow-list, so every call carries the
  // chat session's task. Stable while the session and connection are, or a streaming message would
  // restart its own candidate lookup on every delta.
  const chatTaskId = currentSession?.view === "chat" ? currentSession.taskId : undefined;
  const chatFiles = useMemo<ChatFiles | undefined>(() => {
    if (chatTaskId === undefined) return undefined;
    return {
      resolve: async (paths) =>
        (await api.files.resolve({ taskId: chatTaskId, paths: [...paths] })).results,
      read: (path) => api.files.read({ taskId: chatTaskId, path }),
      open: async (path, line, column) => {
        const opened = await api.files.openEditor({
          taskId: chatTaskId,
          path,
          size: fitSize.current,
          ...(line === undefined ? {} : { line }),
          ...(column === undefined ? {} : { column }),
        });
        // The editor is a terminal in the task's workspace; showing it is what makes the click do
        // something the user can see (`files.openEditor` runs it as a loose terminal).
        choose({ taskId: null, entryId: opened.terminalId });
      },
    };
  }, [api, choose, chatTaskId]);

  const showTask = (task: Task | undefined) =>
    choose({ projectId: task?.projectId ?? undefined, taskId: task?.id, entryId: undefined });

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
      setFailure({ message: failureText(error), tone: "error" });
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
    if (selection.taskId === null || !agentsEnabled) return;
    if (currentTask?.state === "settled") {
      setFailure({ message: SETTLED_TASK_MESSAGE, tone: "notice" });
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
      ...(choice.view === undefined ? {} : { view: choice.view }),
    });
    setDialog(undefined);
    choose({ taskId, entryId: started.id });
  };

  /** Settings overlays the mounted workspace; keep its opener for the modal return. */
  const openSettings = (opener?: HTMLElement) => {
    dialogFocus?.remember(opener);
    onOpenSettings(chosenToSearch(chosenRef.current));
  };

  /** The board overlays the mounted workspace too, so its close restores the same opener. */
  const openBoard = () => {
    dialogFocus?.remember();
    onOpenBoard(chosenToSearch(chosenRef.current));
  };

  const closeTerminal = (id: string) =>
    attempt(async () => {
      if (id === selection.entryId) {
        choose({ taskId: selection.taskId, entryId: activeAfterClose(entryIds, id) });
      }
      await api.terminals.close({ id });
    });

  /**
   * A dead loose terminal's Restart: the same command, arguments, folder and name at the current
   * fit size, selected before the dead row goes. Only a create that fails leaves the dead row and
   * its label in place; a name that cannot be set takes its new terminal with it, because a
   * restart that loses the name has done something else.
   */
  const restartLooseTerminal = (entry: TerminalEntry) =>
    attempt(async () => {
      const dead = entry.terminal;
      const label = dead.label ?? null;
      const created = await api.terminals.create({
        command: dead.command,
        args: dead.args,
        cwd: dead.cwd,
        size: fitSize.current,
      });
      try {
        if (label !== null) await api.terminals.setLabel({ id: created.id, label });
      } catch (error) {
        await api.terminals.close({ id: created.id }).catch(() => undefined);
        throw error;
      }
      choose({ taskId: null, entryId: created.id });
      await api.terminals.close({ id: dead.id });
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
   * (`chat.capabilities`, protocol 10).
   */
  const viewHandoff = (
    session: Session | undefined,
  ): { target: SessionView; live: boolean } | { reason: string } => {
    if (session === undefined) return { reason: "Select an agent session." };
    if (handoff !== undefined) return { reason: "This session is switching views now." };
    if (session.kind === "shell") return { reason: "A shell runs in a terminal only." };
    if (!chatCapabilities.loaded) return { reason: "Waiting for the server's chat drivers." };
    const driver = chatDriverFor(chatCapabilities.drivers, session.kind);
    if (driver === undefined)
      return { reason: `The ${session.kind} agent has no chat driver in this build.` };
    // A both-live driver (OpenCode) keeps the other frontend running: this opens a client beside
    // it, so nothing is lost and no confirmation is needed.
    return {
      target: session.view === "chat" ? "terminal" : "chat",
      live: driver.terminalView === "both-live",
    };
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
  const switchView = async (session: Session, target: SessionView, live = false) => {
    setHandoff({ target, live });
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
    if (offered.live) {
      void attempt(() => switchView(session, offered.target, true));
      return;
    }
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

  /** Saves a rename after its dialog has closed; a refusal is the workspace's notice sentence. */
  const renameEntry = (target: RenameTarget, name: string | null) => {
    void attempt(async () => {
      if (target.type === "task") {
        if (name !== null) await api.tasks.rename({ id: target.id, title: name });
      } else if (target.type === "terminal")
        await api.terminals.setLabel({ id: target.id, label: name });
      else await api.sessions.setLabel({ id: target.id, label: name });
    });
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
    const count = sessionEntries.length;
    return {
      label: `Go to session ${number}`,
      group: "Sessions",
      ...actionAvailability(
        entry !== undefined,
        selection.taskId === null
          ? "Select a task with sessions."
          : count === 0
            ? "This task has no sessions."
            : `This task has only ${count} session${count === 1 ? "" : "s"}.`,
      ),
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
    }
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
      // Before the project list arrives there is no project to point at yet; remember the open
      // so the composer appears as soon as it does. The guard reports a loaded, empty list.
      if (!projectsSnapshot.loaded) {
        composerOpens.current += 1;
        setComposing({ opened: composerOpens.current });
      }
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
  /** The status opens the capability-recovery dialog; no action id, it is a surface. */
  const openConnectionRecovery = (opener?: HTMLElement) =>
    openDialog({ kind: "connection" }, opener);

  const openRemoveTask = (task: Task | undefined) => {
    if (!task) return;
    openDialog({ kind: "remove-task", task });
    if (!task.ownsWorktree) return;
    // `tasks.remove` returns nothing, so the question is answered before it is asked: the same
    // read the Changes tab shows tells whether the directory is already gone. A task in the main
    // tree owns no worktree to prune, and a failed read keeps the ordinary copy.
    const controller = new AbortController();
    removeWorkspaceRead.current = { taskId: task.id, controller };
    void api.changes
      .files({ id: task.id })
      .then((snapshot) => {
        if (controller.signal.aborted) return;
        const workspaceMissing = workspaceMissingPath(snapshot.error ?? "") !== undefined;
        setDialog((open) =>
          open?.kind === "remove-task" &&
          open.task.id === task.id &&
          removeWorkspaceRead.current?.controller === controller
            ? { ...open, workspaceMissing }
            : open,
        );
      })
      .catch(() => undefined);
  };

  /** Cancel/Escape: the read may still finish, but it must not remove anything after the answer. */
  const closeRemoveTask = () => {
    removeWorkspaceRead.current?.controller.abort();
    setDialog(undefined);
  };
  const openRemoveProject = (project: Project, opener?: HTMLElement) =>
    openDialog({ kind: "remove-project", project }, opener);
  const openRemoveSession = (session: Session) => openDialog({ kind: "remove-session", session });
  const openTaskSource = (task: Task, opener?: HTMLElement) =>
    openDialog({ kind: "task-source", task }, opener);

  const addProject = async (path: string) => {
    const project = await api.projects.add({ path });
    setDialog(undefined);
    // Adding a project navigates to it, then opens its composer. `choose()` clears the composer,
    // so the open has to follow it; a zero-task project would otherwise fall back to a loose
    // terminal (`resolveSelection`), and Add project would land there instead of on New task.
    choose({ projectId: project.id, taskId: undefined, entryId: undefined });
    openNewTask(project);
  };

  const createTask = async (input: CreateTaskInput) => {
    const task = await api.tasks.create(input);
    setDialog(undefined);
    // The task owns the draft now; the next composer starts empty in the task's project.
    if (task.projectId !== null) setComposerDraft(emptyDraft(task.projectId));
    // The task's primary session is where the prompt went, when the composer named an agent; a
    // task created without one stays empty until the user adds a session (design.md, **Domain
    // model → Task → Creation**). Creating a task starts no shell.
    choose({
      projectId: task.projectId ?? undefined,
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
    // The dialog's copy may be stale by the time the user confirms, and a read that failed must not
    // become a silent prune: read the workspace once more, here, and abort if the dialog closed.
    const read =
      removeWorkspaceRead.current?.taskId === task.id ? removeWorkspaceRead.current : undefined;
    const controller = read?.controller ?? new AbortController();
    let workspaceMissing = false;
    if (task.ownsWorktree) {
      try {
        const snapshot = await api.changes.files({ id: task.id });
        if (controller.signal.aborted) return;
        workspaceMissing = workspaceMissingPath(snapshot.error ?? "") !== undefined;
      } catch (error) {
        if (controller.signal.aborted) return;
        throw error;
      }
    }
    if (controller.signal.aborted) return;
    const next = taskOrder.find(
      (candidate) =>
        candidate.id ===
        activeAfterClose(
          taskOrder.map((each) => each.id),
          task.id,
        ),
    );
    await api.tasks.remove({ id: task.id, force });
    // The dialog closes itself after a successful removal, so its exit and final focus run;
    // `closeRemoveTask` clears the dialog when that finishes.
    if (task.id === selection.taskId) showTask(next);
    // `showTask` clears the failure, so the notice goes after it. The server pruned the stale git
    // entry because the directory was already gone (a failed prune refuses the removal); the
    // branch is untouched.
    if (workspaceMissing) {
      setFailure({ message: workspaceGoneNotice, tone: "notice" });
    }
  };

  /** The selection the resolver settles on once the removed project's rows are gone. */
  const selectionWithoutProject = (project: Project) =>
    resolveSelection(
      buildWorkspaceTree(
        projects.filter((each) => each.id !== project.id),
        tasks.filter((task) => task.projectId !== project.id),
        sessions,
        terminals,
      ),
      chosenRef.current,
    );

  const removeProject = async (project: Project) => {
    // The selection is what falls back to another project. The composer is only a view of its
    // project, so removing that project closes it the way Escape does: the selected task's
    // Changes tab, the failure and the URL stay exactly as they were.
    const fallback =
      selection.projectId === project.id ? selectionWithoutProject(project) : undefined;
    const composingRemoved = composing?.project?.id === project.id;
    await api.projects.remove({ id: project.id });
    setDialog(undefined);
    // `choose` is the one place that clears the composer, the failure and the Changes tab and
    // rewrites the URL. Without it the removed project's ids would stay in the URL and the tab
    // would keep showing a task that no longer exists.
    if (fallback) choose(fallback);
    else if (composingRemoved) setComposing(undefined);
  };

  const addProjectHint = formatBinding(config, "add-project");
  const addProjectReason =
    addProjectHint === "unbound"
      ? "Add a project first."
      : `Add a project first: ${addProjectHint}.`;
  const agentsEnabled = AgentKind.options.some((kind) => config.agents[kind].enabled.value);
  const settledStart = currentTask?.state === "settled";
  const stopSessionReason =
    currentSession !== undefined && currentSession.state !== "running"
      ? "This session is not running."
      : "Select a running session to stop.";
  const restartSessionReason =
    currentSession === undefined
      ? "Select a session to restart."
      : "This session is running; stop it first.";
  const abortTurnReason =
    chat === undefined
      ? "Only a running chat session has a turn to abort."
      : chat.aborting
        ? "This turn is stopping."
        : "No turn is working in this chat session.";

  const actions: ActionTable = {
    "new-terminal": {
      label: "New terminal",
      group: "Sessions",
      ...actionAvailability(!settledStart, SETTLED_TASK_MESSAGE),
      run: () => void createTerminal(selection.taskId),
    },
    "new-agent": {
      label: "New agent session",
      group: "Sessions",
      ...actionAvailability(
        selection.taskId !== null && agentsEnabled && !settledStart,
        settledStart
          ? SETTLED_TASK_MESSAGE
          : selection.taskId === null
            ? "Select a task to start an agent in."
            : "Every agent is disabled in the config file.",
      ),
      run: openAgentPicker,
    },
    "stop-session": {
      label: "Stop session",
      group: "Sessions",
      ...actionAvailability(
        current?.type === "terminal" || currentSession?.state === "running",
        stopSessionReason,
      ),
      run: () => {
        if (current?.type === "terminal") void closeTerminal(current.id);
        else if (currentSession?.state === "running") void stopSession(currentSession);
      },
    },
    "restart-session": {
      label: "Restart session",
      group: "Sessions",
      ...actionAvailability(
        currentSession !== undefined && currentSession.state !== "running",
        restartSessionReason,
      ),
      run: () => {
        if (currentSession && currentSession.state !== "running")
          void restartSession(currentSession);
      },
    },
    "rename-session": {
      label: "Rename session",
      group: "Sessions",
      ...actionAvailability(current !== undefined, "Select a session or terminal to rename."),
      run: () => {
        if (current) openRenameEntry(current);
      },
    },
    "remove-session": {
      label: "Remove session",
      group: "Sessions",
      ...actionAvailability(currentSession !== undefined, "Select a session to remove."),
      run: () => {
        if (currentSession) openDialog({ kind: "remove-session", session: currentSession });
      },
    },
    "next-session": {
      label: "Next session",
      group: "Sessions",
      ...actionAvailability(entryIds.length > 1, "This task has fewer than two sessions."),
      run: () => stepEntry(1),
    },
    "previous-session": {
      label: "Previous session",
      group: "Sessions",
      ...actionAvailability(entryIds.length > 1, "This task has fewer than two sessions."),
      run: () => stepEntry(-1),
    },
    "abort-turn": {
      label: "Abort the working turn",
      group: "Sessions",
      ...actionAvailability(
        chat !== undefined && chatTurn === "working" && !chat.aborting,
        abortTurnReason,
      ),
      run: () => void attempt(() => chat?.abort() ?? Promise.resolve()),
    },
    "change-model": {
      label: "Change the chat model",
      group: "Sessions",
      ...actionAvailability(canShowChatPicker, "Only a running chat session has a model control."),
      run: () => openDialog({ kind: "chat-model" }),
    },
    "change-reasoning": {
      label: "Change the reasoning level",
      group: "Sessions",
      ...actionAvailability(
        canShowChatPicker,
        "Only a running chat session has a reasoning control.",
      ),
      run: () => openDialog({ kind: "chat-reasoning" }),
    },
    "switch-view": (() => {
      const offered = viewHandoff(currentSession);
      const settledRunning =
        settledStart && currentSession !== undefined && currentSession.state === "running";
      return {
        label:
          "target" in offered
            ? offered.live
              ? `Open the ${offered.target} view`
              : `Switch to ${offered.target}`
            : "Switch view",
        group: "Sessions",
        ...actionAvailability(
          "target" in offered && !settledRunning,
          settledRunning
            ? SETTLED_TASK_MESSAGE
            : "reason" in offered
              ? offered.reason
              : "Select an agent session.",
        ),
        run: () => {
          if (currentSession) requestSwitchView(currentSession);
        },
      };
    })(),
    changes: {
      label: "Changes",
      group: "Sessions",
      ...actionAvailability(selection.taskId !== null, "Select a task to see its changes."),
      run: openChanges,
    },
    // The legacy workspace has one strip of equal session tabs, not the working area's two groups.
    // These entries keep the exhaustive action table typed; the routed shell owns their behavior.
    "close-tab": {
      label: "Close tab",
      group: "Sessions",
      enabled: false,
      reason: "This workspace has no closable tabs.",
      run: () => undefined,
    },
    "reopen-closed-tab": {
      label: "Reopen closed tab",
      group: "Sessions",
      enabled: false,
      reason: "This workspace has no closed tabs.",
      run: () => undefined,
    },
    "toggle-companion": {
      label: "Toggle companion group",
      group: "Sessions",
      enabled: false,
      reason: "This workspace has no companion group.",
      run: () => undefined,
    },
    "move-tab": {
      label: "Move tab to the other group",
      group: "Sessions",
      enabled: false,
      reason: "This workspace has no second group.",
      run: () => undefined,
    },
    "focus-companion": {
      label: "Focus companion group",
      group: "Sessions",
      enabled: false,
      reason: "This workspace has no companion group.",
      run: () => undefined,
    },
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
      // The projects list may still be on its way; the composer opens when it arrives.
      ...actionAvailability(!projectsSnapshot.loaded || projects.length > 0, addProjectReason),
      run: () => openNewTask(),
    },
    "remove-task": {
      label: "Remove task",
      group: "Tasks",
      ...actionAvailability(currentTask !== undefined, "Select a task to remove."),
      run: () => openRemoveTask(currentTask),
    },
    "rename-task": {
      label: "Rename task",
      group: "Tasks",
      ...actionAvailability(currentTask !== undefined, "Select a task to rename."),
      run: () => openRenameTask(currentTask),
    },
    "settle-task": {
      label: "Settle or unsettle task",
      group: "Tasks",
      ...actionAvailability(currentTask !== undefined, "Select a task to settle."),
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
      ...actionAvailability(
        nextTaskId !== undefined && nextTaskId !== selection.taskId,
        "There is no next task.",
      ),
      run: () => stepTask(1),
    },
    "previous-task": {
      label: "Previous task",
      group: "Tasks",
      ...actionAvailability(
        previousTaskId !== undefined && previousTaskId !== selection.taskId,
        "There is no previous task.",
      ),
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
    "focus-sidebar": {
      label: "Focus the sidebar list",
      group: "Navigation",
      enabled: true,
      run: focusSidebarList,
    },
    board: {
      label: "Open board",
      group: "Navigation",
      enabled: true,
      run: openBoard,
    },
    "jump-blocked": {
      label: "Jump to blocked session",
      group: "Navigation",
      ...actionAvailability(mostUrgentBlocked(board) !== undefined, "No blocked sessions."),
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

  /** The one dispatch: a disabled entry says why instead of running. */
  const invoke = (action: ActionId) => {
    const entry = actions[action];
    if (!entry.enabled) {
      setFailure({ message: entry.reason, tone: "notice" });
      return;
    }
    entry.run();
  };

  const keymap = useMemo(() => createConfigKeymap(config), [config]);
  const armed = usePrefixMode(keymap, invoke, active && dialog === undefined);

  const rememberFitSize = useCallback((size: TerminalSize) => {
    fitSize.current = size;
  }, []);

  /** Retries every list; a watch that is still running ignores it, a refused one starts again. */
  const retryWatches = () => {
    client.projects.retry();
    client.tasks.retry();
    client.sessions.retry();
    client.terminals.retry();
  };

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
    watchFailure,
    retryWatches,
    current,
    currentSession,
    chat,
    chatPicker,
    canShowChatPicker,
    chatDriver,
    chatDrivers,
    capabilitiesReady: chatCapabilities.loaded,
    handoff,
    currentTask,
    currentTaskNode,
    currentTaskProject,
    currentSessionLabels,
    changes,
    changesView,
    finishActions,
    pullRequests,
    chatFiles,
    sidebar,
    leaveSidebarList,
    returnToWorkspace,
    taskOrder,
    board,
    dialog,
    composing,
    composerDraft,
    setComposerDraft,
    failure,
    dismissFailure: () => {
      setFailure(undefined);
      // The dismissed control goes with the row; hand the keyboard back to the view's input
      // instead of letting it fall to <body>. An empty shell has none, so this is a no-op.
      returnToWorkspace();
    },
    armed,
    actions,
    invoke,
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
    restartLooseTerminal,
    stopSession,
    restartSession,
    switchView,
    removeSession,
    openRenameEntry,
    openRenameTask,
    openChanges,
    renameEntry,
    selectEntry,
    jumpTo,
    toggleSettle,
    openNewTask,
    closeNewTask,
    loadBranches,
    openRemoveTask,
    closeRemoveTask,
    openRemoveProject,
    openRemoveSession,
    openTaskSource,
    openAddProject,
    openPalette,
    openFindTask,
    openConfigProblems,
    openConnectionRecovery,
    addProject,
    createTask,
    resolveIssue,
    removeTask,
    removeProject,
    setDialog,
  };
}
