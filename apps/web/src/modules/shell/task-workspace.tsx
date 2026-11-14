import { describeStatus, sessionStatus } from "@corral/client/agent-status";
import type { CorralClient } from "@corral/client/corral-client";
import { describeError } from "@corral/client/rpc-errors";
import { describeSessionState } from "@corral/client/session-state";
import { sessionLabels } from "@corral/client/session-labels";
import {
  taskSettingsFor,
  type ActionId,
  type ClientConfig,
  type LaunchProfile,
} from "@corral/protocol/config";
import type {
  AgentKind,
  Session,
  SessionView,
  Task,
  TerminalInfo,
  TerminalSize,
} from "@corral/protocol/rpc";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  DropdownMenuItem,
  VisualAddMenu,
  VisualCompanion,
  VisualIconButton,
  VisualTabPanel,
  VisualTabStrip,
  type VisualTabItem,
} from "../../common/ui/index.ts";
import { ChangesView, createChangesActions, usePullRequests } from "../changes/index.ts";
import {
  ChatChoiceDialog,
  ChatView,
  chatTranscriptStore,
  reconcileTranscriptMemory,
  useChatSession,
  type ChatFiles,
  type ChatTranscriptStore,
} from "../chat/index.ts";
import { ACTION_LABELS, formatBinding, bindingOf } from "../keymap/index.ts";
import {
  AgentPicker,
  describeLaunchError,
  RemoveSessionDialog,
  StoppedSession,
  SwitchViewDialog,
  type AgentLaunchChoice,
} from "../sessions/index.ts";
import { TerminalView } from "../terminal/index.ts";
import { RenameDialog, type RenameTarget } from "../workspace/index.ts";
import {
  activeTab,
  addTab,
  closeTab,
  moveTab,
  removeSession,
  reopenLast,
  selectTab,
  sessionTabAt,
  stepTab,
  tabId,
  tabNumber,
  tabsInGroup,
  toggleCompanion,
  type TaskTabGroup,
} from "./task-tabs.ts";
import {
  companionRange,
  companionWidthFor,
  useCompanionWidth,
  useTaskTabLayout,
} from "./use-task-tabs.ts";

const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };
const MAIN_PANE_ID = "task-main-pane";
const COMPANION_PANE_ID = "task-companion-pane";

/** The view `prefix v` offers this session, or the existing sentence saying why it cannot. */
function viewOffer(
  session: Session,
  drivers: readonly { kind: AgentKind; terminalView: string }[],
  capabilitiesReady: boolean,
): { target: SessionView; live: boolean } | { reason: string } {
  if (session.kind === "shell") return { reason: "A shell runs in a terminal only." };
  if (!capabilitiesReady) return { reason: "Waiting for the server's chat drivers." };
  const driver = drivers.find((candidate) => candidate.kind === session.kind);
  if (driver === undefined)
    return { reason: `The ${session.kind} agent has no chat driver in this build.` };
  return {
    target: session.view === "chat" ? "terminal" : "chat",
    live: driver.terminalView === "both-live",
  };
}

type DialogState =
  | { kind: "pick-agent" }
  | { kind: "remove-session"; session: Session }
  | {
      kind: "switch-view";
      session: Session;
      target: SessionView;
      working: boolean;
      waiting: boolean;
    }
  | { kind: "chat-model"; session: Session }
  | { kind: "chat-reasoning"; session: Session }
  | { kind: "rename"; target: RenameTarget };

export interface TaskWorkspaceController {
  notice: ReactNode;
  chrome: ReactNode;
  main: ReactNode;
  companion: ReactNode;
  dialogs: ReactNode;
  prefix: { bindings: Readonly<Record<string, string>>; onAction: (action: string) => void };
  prefixEnabled: boolean;
}

/** The task's sessions, its device-local layout and every pane the working area mounts. */
export function useTaskWorkspace({
  client,
  task,
  sessions,
  terminals,
  config,
  profiles,
  drivers,
  capabilitiesReady,
  projectPath,
  position,
  active,
}: {
  client: CorralClient;
  task: Task | undefined;
  sessions: readonly Session[];
  terminals: readonly TerminalInfo[];
  config: ClientConfig;
  profiles: readonly LaunchProfile[];
  drivers: readonly { kind: AgentKind; followUp: boolean; terminalView: string }[];
  capabilitiesReady: boolean;
  projectPath: string | undefined;
  position: "top" | "bottom";
  active: boolean;
}): TaskWorkspaceController {
  const ofTask = useMemo(
    () => (task === undefined ? [] : sessions.filter((session) => session.taskId === task.id)),
    [sessions, task],
  );
  const { layout, change } = useTaskTabLayout(task, ofTask);
  const { width: preferredWidth, setWidth: setPreferredWidth } = useCompanionWidth();
  const taskId = task?.id;
  // Working-area actions are per task: switching tasks starts on the main group with no old
  // dialog or failure still holding the keyboard. The setters stay one identity; the ref is
  // updated before any handler can run with the new task.
  const taskIdRef = useRef(taskId);
  useLayoutEffect(() => {
    taskIdRef.current = taskId;
  }, [taskId]);
  const [focusState, setFocusState] = useState<{
    taskId: string | undefined;
    group: TaskTabGroup;
  }>({ group: "main", taskId: undefined });
  const focusGroup = focusState.taskId === taskId ? focusState.group : "main";
  const setFocusGroup = useCallback(
    (group: TaskTabGroup) => setFocusState({ taskId: taskIdRef.current, group }),
    [],
  );
  const [chatDrafts, setChatDrafts] = useState<ReadonlyMap<string, string>>(() => new Map());
  // Scroll offset and open folds per session, beside the draft: a tab switch unmounts the pane.
  const [transcriptMemory, setTranscriptMemory] = useState<
    ReadonlyMap<string, ChatTranscriptStore>
  >(() => new Map());
  const sessionIds = new Set(sessions.map((session) => session.id));
  const memories = reconcileTranscriptMemory(transcriptMemory, sessionIds);
  if (memories !== transcriptMemory) setTranscriptMemory(memories);
  const [dialogState, setDialogState] = useState<
    { taskId: string | undefined; dialog: DialogState | undefined } | undefined
  >();
  const dialog =
    dialogState !== undefined && dialogState.taskId === taskId ? dialogState.dialog : undefined;
  const setDialog = useCallback(
    (next: DialogState | undefined) => setDialogState({ taskId: taskIdRef.current, dialog: next }),
    [],
  );
  const [failureState, setFailureState] = useState<
    { taskId: string | undefined; message: string | undefined } | undefined
  >();
  const failure =
    failureState !== undefined && failureState.taskId === taskId ? failureState.message : undefined;
  const setFailure = useCallback(
    (message: string | undefined) => setFailureState({ taskId: taskIdRef.current, message }),
    [],
  );
  const fitSize = useRef<TerminalSize>(DEFAULT_SIZE);
  const mainPane = useRef<HTMLDivElement>(null);
  const companionPane = useRef<HTMLDivElement>(null);
  const mainModelAnchor = useRef<HTMLButtonElement>(null);
  const mainReasoningAnchor = useRef<HTMLButtonElement>(null);
  const companionModelAnchor = useRef<HTMLButtonElement>(null);
  const companionReasoningAnchor = useRef<HTMLButtonElement>(null);
  const [available, setAvailable] = useState(() => Math.max(0, window.innerWidth - 336));

  const sessionById = useMemo(
    () => new Map(ofTask.map((session) => [session.id, session])),
    [ofTask],
  );
  const labels = useMemo(() => sessionLabels(ofTask), [ofTask]);
  const mainTab = layout === undefined ? undefined : activeTab(layout, "main");
  const companionTab = layout === undefined ? undefined : activeTab(layout, "companion");
  const mainSession =
    mainTab?.kind === "session" ? sessionById.get(mainTab.sessionId ?? "") : undefined;
  const companionSession =
    companionTab?.kind === "session" ? sessionById.get(companionTab.sessionId ?? "") : undefined;
  const mainChat = useChatSession(client, mainSession);
  const companionChat = useChatSession(client, companionSession);
  const companionHasSession =
    layout !== undefined && tabsInGroup(layout, "companion").some((tab) => tab.kind === "session");
  // A companion holding only Changes has no session to step through or hand over; those chords
  // fall back to the main group, which always has one while the task has any session.
  const actionGroup: TaskTabGroup =
    focusGroup === "companion" && !companionHasSession ? "main" : focusGroup;
  const focusedSession = actionGroup === "main" ? mainSession : companionSession;
  const focusedChat = actionGroup === "main" ? mainChat : companionChat;

  const chatFor = (session: Session | undefined) =>
    session === undefined
      ? undefined
      : session.id === mainSession?.id
        ? mainChat
        : session.id === companionSession?.id
          ? companionChat
          : undefined;

  const changes = useSyncExternalStore(client.changes.subscribe, client.changes.getSnapshot);
  const changesActions = useMemo(
    () => (task === undefined ? undefined : createChangesActions(client, task.id)),
    [client, task],
  );
  const pullRequests = usePullRequests(
    (id) => (task?.id === id ? changesActions : undefined),
    task === undefined ? [] : [task.id],
  );

  const chatFiles = useMemo<ChatFiles | undefined>(() => {
    if (task === undefined) return undefined;
    const chatTaskId = task.id;
    return {
      resolve: async (paths) =>
        (await client.connection.api.files.resolve({ taskId: chatTaskId, paths: [...paths] }))
          .results,
      read: (path) => client.connection.api.files.read({ taskId: chatTaskId, path }),
      open: async (path, line, column) => {
        await client.connection.api.files.openEditor({
          taskId: chatTaskId,
          path,
          size: fitSize.current,
          ...(line === undefined ? {} : { line }),
          ...(column === undefined ? {} : { column }),
        });
      },
    };
  }, [client, task]);

  const report = useCallback(
    (error: unknown) => {
      setFailure(describeLaunchError(error) ?? describeError(error));
    },
    [setFailure],
  );

  const rememberFitSize = useCallback((size: TerminalSize) => {
    fitSize.current = size;
  }, []);

  const focusPane = useCallback((group: TaskTabGroup) => {
    requestAnimationFrame(() => {
      const node = group === "main" ? mainPane.current : companionPane.current;
      node
        ?.querySelector<HTMLElement>(
          'textarea[aria-label="Message"], textarea[aria-label="Prompt"], .xterm-helper-textarea',
        )
        ?.focus();
    });
  }, []);

  const focusTab = useCallback((id: string) => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-tab-id="${CSS.escape(id)}"]`)?.focus();
    });
  }, []);

  const focusAddSession = useCallback(() => {
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(
          '.visual-tab-trailing [aria-label="Add session"], .visual-workspace-empty [aria-label="Add session"]',
        )
        ?.focus();
    });
  }, []);

  const addSession = useCallback(
    (session: Session) => {
      change((current) =>
        addTab(current, { kind: "session", sessionId: session.id, group: "main" }),
      );
      setFocusGroup("main");
      focusPane("main");
    },
    [change, focusPane, setFocusGroup],
  );

  /** Starts the session and leaves the tab to the caller, so a picker can show its own refusal. */
  const launch = useCallback(
    async (
      kind: Session["kind"],
      choice?: AgentLaunchChoice,
      view?: SessionView,
    ): Promise<Session> => {
      if (task === undefined) throw new Error("Select a task first.");
      const chosenView = view ?? choice?.view;
      return client.connection.api.sessions.start({
        taskId: task.id,
        kind,
        size: fitSize.current,
        ...(choice?.profileId === undefined
          ? {}
          : {
              profileId: choice.profileId,
              ...(choice.expectedProfileRevision === undefined
                ? {}
                : { expectedProfileRevision: choice.expectedProfileRevision }),
            }),
        ...(choice?.model === undefined ? {} : { model: choice.model }),
        ...(chosenView === undefined ? {} : { view: chosenView }),
      });
    },
    [client, task],
  );

  const startSession = useCallback(
    async (kind: Session["kind"], choice?: AgentLaunchChoice, view?: SessionView) => {
      setFailure(undefined);
      try {
        const started = await launch(kind, choice, view);
        addSession(started);
      } catch (error) {
        report(error);
      }
    },
    [addSession, launch, report, setFailure],
  );

  const openAgentPicker = useCallback(() => {
    if (task === undefined) return;
    setFailure(undefined);
    setDialog({ kind: "pick-agent" });
  }, [setDialog, setFailure, task]);

  const openChanges = useCallback(() => {
    setFailure(undefined);
    change((current) => addTab(current, { kind: "changes", group: "companion" }));
    setFocusGroup("companion");
    // Changes has no composer or terminal input; the tab itself is the deterministic focus point.
    focusTab("changes");
  }, [change, focusTab, setFailure, setFocusGroup]);

  const closeFocused = useCallback(() => {
    if (layout === undefined || task === undefined) return;
    setFailure(undefined);
    const tab = activeTab(layout, focusGroup);
    if (tab === undefined) return;
    const id = tabId(tab);
    const after = closeTab(layout, id, task.primarySessionId);
    if (after === layout) {
      if (tab.kind === "session" && tab.sessionId === task.primarySessionId)
        setFailure("The primary session is not a closable view; remove it with Remove session.");
      return;
    }
    change((current) => closeTab(current, id, task.primarySessionId));
    const remaining = activeTab(after, tab.group);
    if (remaining !== undefined) {
      setFocusGroup(tab.group);
      focusTab(tabId(remaining));
      return;
    }
    setFocusGroup("main");
    const main = activeTab(after, "main");
    if (main !== undefined) focusTab(tabId(main));
    else focusAddSession();
  }, [change, focusAddSession, focusGroup, focusTab, layout, setFailure, setFocusGroup, task]);

  const reopen = useCallback(() => {
    if (layout === undefined || task === undefined) return;
    setFailure(undefined);
    const after = reopenLast(layout, task, ofTask);
    if (after === layout) return;
    change((current) => reopenLast(current, task, ofTask));
    const group: TaskTabGroup =
      after.active.companion !== layout.active.companion ? "companion" : "main";
    setFocusGroup(group);
    const tab = activeTab(after, group);
    if (tab !== undefined) focusTab(tabId(tab));
    else focusAddSession();
  }, [change, focusAddSession, focusTab, layout, ofTask, setFailure, setFocusGroup, task]);

  const select = useCallback(
    (id: string) => {
      if (layout === undefined) return;
      const tab = layout.tabs.find((candidate) => tabId(candidate) === id);
      if (tab === undefined) return;
      setFailure(undefined);
      change((current) => selectTab(current, id));
      setFocusGroup(tab.group);
      focusPane(tab.group);
    },
    [change, focusPane, layout, setFailure, setFocusGroup],
  );

  const close = useCallback(
    (id: string) => {
      if (layout === undefined || task === undefined) return;
      setFailure(undefined);
      const tab = layout.tabs.find((candidate) => tabId(candidate) === id);
      if (tab === undefined) return;
      const after = closeTab(layout, id, task.primarySessionId);
      if (after === layout) return;
      change((current) => closeTab(current, id, task.primarySessionId));
      const remaining = activeTab(after, tab.group);
      if (remaining !== undefined) {
        setFocusGroup(tab.group);
        focusTab(tabId(remaining));
        return;
      }
      setFocusGroup("main");
      const main = activeTab(after, "main");
      if (main !== undefined) focusTab(tabId(main));
      else focusAddSession();
    },
    [change, focusAddSession, focusTab, layout, setFailure, setFocusGroup, task],
  );

  const move = useCallback(() => {
    if (layout === undefined || task === undefined) return;
    setFailure(undefined);
    const tab = activeTab(layout, focusGroup);
    if (tab === undefined) return;
    const after = moveTab(layout, tabId(tab), task.primarySessionId);
    if (after === layout) {
      setFailure(
        tab.kind === "changes"
          ? "Changes stays in the companion group."
          : tab.kind === "session" && tab.sessionId === task.primarySessionId
            ? "The primary session is not moved between groups."
            : "The main group keeps its only tab.",
      );
      return;
    }
    change((current) => moveTab(current, tabId(tab), task.primarySessionId));
    const group: TaskTabGroup = tab.group === "main" ? "companion" : "main";
    setFocusGroup(group);
    const moved = activeTab(after, group);
    if (moved !== undefined) focusTab(tabId(moved));
    else focusAddSession();
  }, [change, focusAddSession, focusTab, focusGroup, layout, setFailure, setFocusGroup, task]);

  const step = useCallback(
    (direction: 1 | -1) => {
      if (layout === undefined) return;
      const tab = stepTab(layout, actionGroup, direction);
      if (tab === undefined) return;
      select(tabId(tab));
    },
    [actionGroup, layout, select],
  );

  const selectNumber = useCallback(
    (number: number) => {
      if (layout === undefined) return;
      const tab = sessionTabAt(layout, actionGroup, number);
      if (tab !== undefined) select(tabId(tab));
    },
    [actionGroup, layout, select],
  );

  const setView = useCallback(
    async (session: Session, target: SessionView) => {
      setFailure(undefined);
      try {
        await client.connection.api.sessions.setView({
          id: session.id,
          view: target,
          size: fitSize.current,
        });
        setDialog(undefined);
        focusPane(session.id === companionSession?.id ? "companion" : "main");
      } catch (error) {
        report(error);
      }
    },
    [client, companionSession, focusPane, report, setDialog, setFailure],
  );

  const switchSession = useCallback(
    async (session: Session) => {
      const offer = viewOffer(session, drivers, capabilitiesReady);
      if ("reason" in offer) {
        setFailure(offer.reason);
        return;
      }
      const chat =
        session.id === mainSession?.id
          ? mainChat
          : session.id === companionSession?.id
            ? companionChat
            : undefined;
      // Only the active tab in each group has an open chat store. A menu action on another
      // running chat cannot know its turn, so it asks instead of claiming the turn is idle.
      const unknownChat =
        session.view === "chat" && session.state === "running" && chat === undefined;
      const working =
        session.view === "chat"
          ? chat !== undefined && chat.store.getSnapshot().state.turn === "working"
          : ["working", "blocked"].includes(sessionStatus(session)?.state ?? "");
      const waiting =
        session.view === "chat"
          ? (chat?.store
              .getSnapshot()
              .items.some((item) => item.kind === "user-request" && item.status === "pending") ??
            false)
          : sessionStatus(session)?.state === "blocked";
      if (!offer.live && (unknownChat || working || waiting)) {
        setDialog({
          kind: "switch-view",
          session,
          target: offer.target,
          working: unknownChat ? false : working,
          waiting: unknownChat ? false : waiting,
        });
        return;
      }
      await setView(session, offer.target);
    },
    [
      capabilitiesReady,
      companionChat,
      companionSession?.id,
      drivers,
      mainChat,
      mainSession?.id,
      setDialog,
      setFailure,
      setView,
    ],
  );

  const switchActive = useCallback(() => {
    if (focusedSession === undefined) {
      setFailure("Select an agent session.");
      return;
    }
    void switchSession(focusedSession);
  }, [focusedSession, setFailure, switchSession]);

  const stopSession = useCallback(
    async (session: Session) => {
      setFailure(undefined);
      try {
        await client.connection.api.sessions.stop({ id: session.id });
      } catch (error) {
        report(error);
      }
    },
    [client, report, setFailure],
  );

  const restartSession = useCallback(
    async (session: Session) => {
      setFailure(undefined);
      try {
        await client.connection.api.sessions.restart({
          id: session.id,
          size: fitSize.current,
        });
        focusPane(session.id === companionSession?.id ? "companion" : "main");
      } catch (error) {
        report(error);
      }
    },
    [client, companionSession, focusPane, report, setFailure],
  );

  const remove = useCallback(
    async (session: Session) => {
      setFailure(undefined);
      await client.connection.api.sessions.remove({ id: session.id });
      setDialog(undefined);
      const after = layout === undefined ? undefined : removeSession(layout, session.id);
      change((current) => removeSession(current, session.id));
      if (after !== undefined && tabsInGroup(after, "companion").length === 0) {
        setFocusGroup("main");
        const main = activeTab(after, "main");
        if (main !== undefined) focusTab(tabId(main));
        else focusAddSession();
      }
    },
    [change, client, focusAddSession, focusTab, layout, setDialog, setFailure, setFocusGroup],
  );

  const toggleGroup = useCallback(() => {
    if (layout === undefined) return;
    const next = toggleCompanion(layout);
    change((current) => toggleCompanion(current));
    setFocusGroup(next.companionOpen ? "companion" : "main");
    if (next.companionOpen) focusPane("companion");
    else focusPane("main");
  }, [change, focusPane, layout, setFocusGroup]);

  const focusCompanion = useCallback(() => {
    if (layout === undefined) return;
    // A second press of the focus chord returns to the main group. It is the keyboard's way
    // out when the companion holds only Changes and the number/step chords have nothing to do.
    if (focusGroup === "companion") {
      setFocusGroup("main");
      focusPane("main");
      return;
    }
    if (tabsInGroup(layout, "companion").length === 0) {
      change((current) => toggleCompanion(current));
      setFocusGroup("companion");
      focusPane("companion");
      return;
    }
    const tab = activeTab(layout, "companion") ?? tabsInGroup(layout, "companion")[0];
    if (tab === undefined) return;
    change((current) => selectTab({ ...current, companionOpen: true }, tabId(tab)));
    setFocusGroup("companion");
    focusPane("companion");
  }, [change, focusGroup, focusPane, layout, setFocusGroup]);

  const abort = useCallback(async () => {
    if (focusedChat === undefined) return;
    setFailure(undefined);
    try {
      await focusedChat.abort();
    } catch (error) {
      report(error);
    }
  }, [focusedChat, report, setFailure]);

  const openModelPicker = useCallback(
    (session: Session | undefined) => {
      const chat =
        session === undefined
          ? undefined
          : session.id === mainSession?.id
            ? mainChat
            : session.id === companionSession?.id
              ? companionChat
              : undefined;
      if (session === undefined || chat === undefined) {
        setFailure("Only a running chat session has a model control.");
        return;
      }
      setDialog({ kind: "chat-model", session });
    },
    [companionChat, companionSession?.id, mainChat, mainSession?.id, setDialog, setFailure],
  );
  const openReasoningPicker = useCallback(
    (session: Session | undefined) => {
      const chat =
        session === undefined
          ? undefined
          : session.id === mainSession?.id
            ? mainChat
            : session.id === companionSession?.id
              ? companionChat
              : undefined;
      if (session === undefined || chat === undefined) {
        setFailure("Only a running chat session has a reasoning control.");
        return;
      }
      setDialog({ kind: "chat-reasoning", session });
    },
    [companionChat, companionSession?.id, mainChat, mainSession?.id, setDialog, setFailure],
  );

  const runAction = useCallback(
    (action: string) => {
      if (action === "new-terminal") void startSession("shell");
      else if (action === "new-agent") openAgentPicker();
      else if (action === "changes") openChanges();
      else if (action === "switch-view") switchActive();
      else if (action === "close-tab") closeFocused();
      else if (action === "reopen-closed-tab") reopen();
      else if (action === "toggle-companion") toggleGroup();
      else if (action === "move-tab") move();
      else if (action === "focus-companion") focusCompanion();
      else if (action === "next-session") step(1);
      else if (action === "previous-session") step(-1);
      else if (action === "stop-session" && focusedSession !== undefined)
        void stopSession(focusedSession);
      else if (action === "restart-session" && focusedSession !== undefined)
        void restartSession(focusedSession);
      else if (action === "abort-turn") void abort();
      else if (action === "change-model") openModelPicker(focusedSession);
      else if (action === "change-reasoning") openReasoningPicker(focusedSession);
      else if (action === "remove-session" && focusedSession !== undefined)
        setDialog({ kind: "remove-session", session: focusedSession });
      else if (action === "rename-session" && focusedSession !== undefined)
        setDialog({
          kind: "rename",
          target: {
            type: "session",
            id: focusedSession.id,
            name: labels.get(focusedSession.id) ?? focusedSession.kind,
            value: focusedSession.label ?? "",
          },
        });
      else if (action.startsWith("session-")) {
        const number = Number(action.slice("session-".length));
        if (Number.isInteger(number)) selectNumber(number);
      }
    },
    [
      abort,
      closeFocused,
      focusCompanion,
      focusedSession,
      labels,
      move,
      openAgentPicker,
      openChanges,
      openModelPicker,
      openReasoningPicker,
      reopen,
      restartSession,
      selectNumber,
      startSession,
      step,
      stopSession,
      setDialog,
      switchActive,
      toggleGroup,
    ],
  );

  const runActionRef = useRef(runAction);
  useLayoutEffect(() => {
    runActionRef.current = runAction;
  }, [runAction]);
  const stableOnAction = useCallback((action: string) => runActionRef.current(action), []);

  const bindings = useMemo(() => {
    const result: Record<string, string> = {};
    const actions: ActionId[] = [
      "new-terminal",
      "new-agent",
      "changes",
      "switch-view",
      "close-tab",
      "reopen-closed-tab",
      "toggle-companion",
      "move-tab",
      "focus-companion",
      "next-session",
      "previous-session",
      "stop-session",
      "restart-session",
      "abort-turn",
      "change-model",
      "change-reasoning",
      "remove-session",
      "rename-session",
      "session-1",
      "session-2",
      "session-3",
      "session-4",
      "session-5",
      "session-6",
      "session-7",
      "session-8",
      "session-9",
    ];
    for (const action of actions) {
      const chord = bindingOf(config, action);
      if (typeof chord === "string") result[chord] = action;
    }
    return result;
  }, [config]);

  useLayoutEffect(() => {
    const node = document.querySelector<HTMLElement>(".visual-workspace-body");
    if (node === null) return undefined;
    const measure = () => setAvailable(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const companionWidth = companionWidthFor(preferredWidth, available);
  const companionLimits = companionRange(available);
  // The handle starts from the rendered width; store the value the frame can actually show.
  const resizeCompanion = useCallback(
    (next: number) => {
      setPreferredWidth(
        Math.max(companionLimits.min, Math.min(companionLimits.max, Math.round(next))),
      );
    },
    [companionLimits.max, companionLimits.min, setPreferredWidth],
  );

  const sessionItems = (group: TaskTabGroup): VisualTabItem[] => {
    if (layout === undefined) return [];
    const paneId = group === "main" ? MAIN_PANE_ID : COMPANION_PANE_ID;
    return tabsInGroup(layout, group).flatMap((tab): VisualTabItem[] => {
      const id = tabId(tab);
      if (tab.kind === "session") {
        const session = sessionById.get(tab.sessionId ?? "");
        if (session === undefined) return [];
        const described = describeSessionState(session);
        const status = sessionStatus(session);
        const shown =
          described.badge === "failed" || session.state === "unresumable"
            ? {
                state: "error" as const,
                updatedAt: status?.updatedAt ?? session.createdAt,
                ...(status?.message === undefined ? {} : { message: status.message }),
              }
            : status;
        const label = labels.get(session.id) ?? session.kind;
        const badge = described.badge === undefined ? undefined : described.badge;
        const stateWord = badge ?? (shown === undefined ? undefined : describeStatus(shown));
        const offer = viewOffer(session, drivers, capabilitiesReady);
        const viewLabel =
          "target" in offer
            ? offer.live
              ? `Open the ${offer.target} view`
              : `Switch to ${offer.target}`
            : ACTION_LABELS["switch-view"];
        return [
          {
            id,
            kind: "session" as const,
            label,
            ariaLabel: [label, stateWord].filter(Boolean).join(" "),
            menuLabel: `Session actions for ${label}`,
            number: tabNumber(layout, id),
            agentKind: session.kind,
            status: shown,
            selected: layout.active[group] === id,
            canClose: session.id !== task?.primarySessionId,
            title: [label, described.badge, status?.message].filter(Boolean).join(" · "),
            paneId,
            menu: (
              <>
                {session.state === "running" ? (
                  <DropdownMenuItem onClick={() => void stopSession(session)}>
                    Stop {label}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={() => void restartSession(session)}>
                    {described.action ?? "Restart"} {label}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  disabled={"reason" in offer}
                  title={"reason" in offer ? offer.reason : undefined}
                  onClick={() => void switchSession(session)}
                >
                  {viewLabel}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    setDialog({
                      kind: "rename",
                      target: {
                        type: "session",
                        id: session.id,
                        name: label,
                        value: session.label ?? "",
                      },
                    })
                  }
                >
                  Rename…
                </DropdownMenuItem>
                {session.id !== task?.primarySessionId && (
                  <DropdownMenuItem onClick={() => close(id)}>Close tab</DropdownMenuItem>
                )}
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setDialog({ kind: "remove-session", session })}
                >
                  Remove session…
                </DropdownMenuItem>
              </>
            ),
          },
        ];
      }
      if (tab.kind === "changes") {
        return [
          {
            id,
            kind: "changes" as const,
            label: "Changes",
            selected: layout.active[group] === id,
            canClose: true,
            paneId,
          },
        ];
      }
      return [
        {
          id,
          kind: "file" as const,
          label: tab.path ?? "",
          selected: layout.active[group] === id,
          canClose: true,
          paneId,
        },
      ];
    });
  };

  const changesBinding = bindingOf(config, "changes");
  const addSessionMenu = (
    <>
      <DropdownMenuItem onClick={() => void startSession("shell")}>Shell</DropdownMenuItem>
      <DropdownMenuItem onClick={openAgentPicker}>Agent…</DropdownMenuItem>
    </>
  );
  const addSessionControl = (
    <VisualAddMenu
      label="Add session"
      tooltip={`Add session · ${formatBinding(config, "new-terminal")} / ${formatBinding(config, "new-agent")}`}
    >
      {addSessionMenu}
    </VisualAddMenu>
  );
  const trailing = (
    <>
      <VisualIconButton
        label="Changes"
        icon="changes"
        onClick={openChanges}
        shortcut={
          changesBinding === null
            ? undefined
            : { prefix: config.keys.prefix, binding: changesBinding }
        }
      />
      {addSessionControl}
    </>
  );

  const strip = (group: TaskTabGroup) => (
    <VisualTabStrip
      label={group === "main" ? "Sessions" : "Companion tabs"}
      items={sessionItems(group)}
      position={position}
      onSelect={select}
      onClose={close}
      trailing={group === "main" ? trailing : null}
    />
  );

  const sessionPane = (session: Session | undefined, group: TaskTabGroup): ReactNode => {
    if (session === undefined) return null;
    const chat = chatFor(session);
    const terminal = terminals.find((candidate) => candidate.id === session.terminalId);
    if (
      session.view === "chat" &&
      session.state === "running" &&
      session.kind !== "shell" &&
      chat !== undefined &&
      chatFiles !== undefined
    ) {
      const driver = drivers.find((candidate) => candidate.kind === session.kind);
      return (
        <ChatView
          key={session.id}
          store={chat.store}
          memory={memories.get(session.id) ?? chatTranscriptStore()}
          draft={chatDrafts.get(session.id) ?? ""}
          onDraftChange={(update) => {
            setChatDrafts((previous) => {
              const value = previous.get(session.id) ?? "";
              const next = typeof update === "function" ? update(value) : update;
              if (next === value) return previous;
              const drafts = new Map(previous);
              if (next === "") drafts.delete(session.id);
              else drafts.set(session.id, next);
              return drafts;
            });
          }}
          files={chatFiles}
          agent={session.kind}
          followUp={driver?.followUp}
          modelPickerAnchor={group === "main" ? mainModelAnchor : companionModelAnchor}
          reasoningPickerAnchor={group === "main" ? mainReasoningAnchor : companionReasoningAnchor}
          canChooseAgent={Object.values(config.agents).some((agent) => agent.enabled.value)}
          aborting={chat.aborting}
          onSend={chat.send}
          onAbort={chat.abort}
          onRespond={chat.respond}
          onChangeModel={() => openModelPicker(session)}
          onChangeReasoning={() => openReasoningPicker(session)}
        />
      );
    }
    if (terminal !== undefined && session.view === "terminal") {
      const restartHint = bindingOf(config, "restart-session");
      return (
        <TerminalView
          key={terminal.id}
          client={client}
          terminal={terminal}
          onFit={rememberFitSize}
          exitHint={
            `${describeSessionState(session).note ?? ""} ${
              restartHint === null ? "" : `Press ${formatBinding(config, "restart-session")}.`
            }`.trim() || undefined
          }
        />
      );
    }
    if (session.state !== "running") {
      return (
        <StoppedSession
          key={session.id}
          session={session}
          restartHint={formatBinding(config, "restart-session")}
          onRestart={() => void restartSession(session)}
        />
      );
    }
    return null;
  };

  const mainPaneContent =
    layout === undefined ? null : (
      <VisualTabPanel
        id={MAIN_PANE_ID}
        labelledBy={mainTab === undefined ? undefined : `tab-${tabId(mainTab)}`}
        fill
        panelRef={mainPane}
      >
        <div className="visual-workspace-pane" onFocusCapture={() => setFocusGroup("main")}>
          {tabsInGroup(layout, "main").some((tab) => tab.kind === "session") ? (
            // oxlint-disable-next-line react/refs -- the anchors are passed to ChatView, not read here
            sessionPane(mainSession, "main")
          ) : (
            <div className="visual-main-empty visual-workspace-empty">{addSessionControl}</div>
          )}
        </div>
      </VisualTabPanel>
    );

  const companionPaneContent =
    layout === undefined || tabsInGroup(layout, "companion").length === 0 ? null : (
      <VisualCompanion
        open={layout.companionOpen}
        width={companionWidth}
        min={companionLimits.min}
        max={companionLimits.max}
        onResize={resizeCompanion}
        label="Resize companion group"
      >
        {position === "top" && strip("companion")}
        <VisualTabPanel
          id={COMPANION_PANE_ID}
          labelledBy={companionTab === undefined ? undefined : `tab-${tabId(companionTab)}`}
          fill
          panelRef={companionPane}
        >
          <div className="visual-workspace-pane" onFocusCapture={() => setFocusGroup("companion")}>
            {companionTab?.kind === "changes" &&
            task !== undefined &&
            changesActions !== undefined ? (
              <ChangesView
                key={task.id}
                task={task}
                changes={changes.byTask.get(task.id)}
                failed={changes.failed}
                store={client.changes}
                actions={changesActions}
                pullRequest={pullRequests.byTask.get(task.id)}
                onPullRequest={(request) => pullRequests.remember(request)}
                onSettle={() => {
                  void client.connection.api.tasks.setState({
                    id: task.id,
                    state: task.state === "active" ? "settled" : "active",
                  });
                }}
              />
            ) : (
              // oxlint-disable-next-line react/refs -- the anchors are passed to ChatView, not read here
              sessionPane(companionSession, "companion")
            )}
          </div>
        </VisualTabPanel>
        {position === "bottom" && strip("companion")}
      </VisualCompanion>
    );

  const dialogs =
    task === undefined ? null : (
      <>
        {dialog?.kind === "pick-agent" && (
          <AgentPicker
            profiles={profiles}
            agents={config.agents}
            settings={taskSettingsFor(config, projectPath ?? "")}
            chatDrivers={drivers.map((driver) => driver.kind)}
            capabilitiesReady={capabilitiesReady}
            onStart={async (choice) => {
              const started = await launch(choice.kind, choice, choice.view);
              addSession(started);
              setDialog(undefined);
            }}
            onClose={() => setDialog(undefined)}
          />
        )}
        {dialog?.kind === "remove-session" && (
          <RemoveSessionDialog
            session={dialog.session}
            onRemove={() => remove(dialog.session)}
            onClose={() => setDialog(undefined)}
          />
        )}
        {dialog?.kind === "switch-view" && (
          <SwitchViewDialog
            session={dialog.session}
            target={dialog.target}
            working={dialog.working}
            waiting={dialog.waiting}
            onSwitch={() => setView(dialog.session, dialog.target)}
            onClose={() => setDialog(undefined)}
          />
        )}
        {(dialog?.kind === "chat-model" || dialog?.kind === "chat-reasoning") &&
          (() => {
            const chat = chatFor(dialog.session);
            if (chat === undefined || dialog.session.kind === "shell") return null;
            return (
              <ChatChoiceDialog
                context={{ taskId: task.id }}
                store={chat.store}
                kind={dialog.kind === "chat-model" ? "model" : "reasoning"}
                agent={dialog.session.kind}
                launch={dialog.session.launch}
                profiles={profiles}
                agents={config.agents}
                settings={taskSettingsFor(config, projectPath ?? "")}
                chatDrivers={drivers.map((driver) => driver.kind)}
                anchor={
                  dialog.session.id === companionSession?.id
                    ? dialog.kind === "chat-model"
                      ? companionModelAnchor
                      : companionReasoningAnchor
                    : dialog.kind === "chat-model"
                      ? mainModelAnchor
                      : mainReasoningAnchor
                }
                onStart={async (choice) => {
                  const started = await launch(choice.kind, choice, choice.view);
                  addSession(started);
                }}
                onSetModel={chat.setModel}
                onSetReasoning={chat.setReasoning}
                onClose={() => setDialog(undefined)}
              />
            );
          })()}
        {dialog?.kind === "rename" && (
          <RenameDialog
            target={dialog.target}
            onSave={(name) => {
              setDialog(undefined);
              setFailure(undefined);
              void client.connection.api.sessions
                .setLabel({ id: dialog.target.id, label: name })
                .catch(report);
            }}
            onClose={() => setDialog(undefined)}
          />
        )}
      </>
    );

  const hasTask = task !== undefined;
  const prefix = useMemo(
    () =>
      hasTask ? { bindings, onAction: stableOnAction } : { bindings: {}, onAction: stableOnAction },
    [bindings, hasTask, stableOnAction],
  );

  return {
    notice:
      failure === undefined ? null : (
        <p className="visual-workspace-alert" role="alert">
          {failure}
        </p>
      ),
    chrome: position === "top" ? strip("main") : undefined,
    main: (
      <>
        {mainPaneContent}
        {position === "bottom" && strip("main")}
      </>
    ),
    companion: companionPaneContent,
    dialogs,
    prefix,
    prefixEnabled: active && dialog === undefined,
  };
}
