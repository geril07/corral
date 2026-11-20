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
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ADD_SESSION_SELECTOR, requestAreaFocus } from "../../common/focus/index.ts";
import {
  DropdownMenuItem,
  firstFocusable,
  VisualAddMenu,
  VisualIconButton,
  VisualTabPanel,
  VisualTabStrip,
  VisualWorkspaceGroups,
  type VisualTabDrop,
  type VisualTabItem,
} from "../../common/ui/index.ts";
import {
  ChatChoiceDialog,
  ChatView,
  chatTranscriptStore,
  reconcileTranscriptMemory,
  useChatSession,
  useChatTurn,
  type ChatFiles,
  type ChatTranscriptStore,
} from "../chat/index.ts";
import {
  ACTION_LABELS,
  actionAvailability as availabilityOf,
  bindingOf,
  formatBinding,
  type ActionAvailability,
} from "../keymap/index.ts";
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
  COMPANION_DEFAULT_WIDTH,
  focusGroup as focusLayoutGroup,
  moveTab,
  removeSession,
  selectTab,
  sessionTabAt,
  stepTab,
  tabId,
  tabNumber,
  tabsInGroup,
  toggleExpanded,
  type TaskTabGroup,
} from "./task-tabs.ts";
import { companionRange, companionWidthFor, useTaskTabLayout } from "./use-task-tabs.ts";
import { useChatDrafts } from "./use-chat-drafts.ts";
import { DRAFT_STORAGE_NOTICE } from "./use-task-drafts.ts";

const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };
const MAIN_PANE_ID = "task-main-pane";
const COMPANION_PANE_ID = "task-companion-pane";

/** A loose terminal's tab label: its own name, else the program and the folder it runs in. */
function terminalLabel(terminal: TerminalInfo): string {
  if (terminal.label) return terminal.label;
  const program = terminal.command.split("/").pop() || terminal.command;
  const folder = terminal.cwd.replace(/\/+$/, "").split("/").pop() || "/";
  return `${program} · ${folder}`;
}
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

type DialogOrigin = "menu" | "key";

type DialogState =
  | { kind: "pick-agent"; group: TaskTabGroup }
  | { kind: "remove-session"; session: Session; origin: DialogOrigin }
  | {
      kind: "switch-view";
      session: Session;
      target: SessionView;
      working: boolean;
      waiting: boolean;
      origin: DialogOrigin;
    }
  | { kind: "chat-model"; session: Session }
  | { kind: "chat-reasoning"; session: Session }
  | { kind: "rename"; target: RenameTarget; origin: DialogOrigin };

interface PendingSessionTab {
  session: Session;
  owner: Pick<Task, "id" | "primarySessionId">;
  group: TaskTabGroup;
}

export interface TaskWorkspaceController {
  notice: ReactNode;
  main: ReactNode;
  dialogs: ReactNode;
  prefix: { bindings: Readonly<Record<string, string>>; onAction: (action: string) => void };
  prefixEnabled: boolean;
  /** What the palette and a refused chord say about the actions this controller dispatches. */
  actionAvailability: Readonly<Partial<Record<ActionId, ActionAvailability>>>;
}

/** The group's selected tab, then its add control: a live place when the opener is gone. */
function groupFallback(group: TaskTabGroup): HTMLElement | null {
  const node = document.querySelector<HTMLElement>(
    group === "companion"
      ? ".visual-workspace-group-companion"
      : ".visual-workspace-group:not(.visual-workspace-group-companion)",
  );
  return (
    node?.querySelector<HTMLElement>('[data-tab-id][aria-selected="true"]') ??
    node?.querySelector<HTMLElement>('[aria-label="Add session"]') ??
    null
  );
}

/** The task's sessions, its device-local layout and every pane the working area mounts. */
export function useTaskWorkspace({
  client,
  task,
  sessions,
  terminals,
  terminalsLoaded,
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
  /** False until `terminals.watch` has answered once, so cleanup never drops a tab on an empty first list. */
  terminalsLoaded: boolean;
  config: ClientConfig;
  profiles: readonly LaunchProfile[];
  drivers: readonly {
    kind: AgentKind;
    followUp: boolean;
    modelSwitch: boolean;
    reasoningLevels: boolean;
    terminalView: string;
  }[];
  capabilitiesReady: boolean;
  projectPath: string | undefined;
  position: "top" | "bottom";
  active: boolean;
}): TaskWorkspaceController {
  const ofTask = useMemo(
    () => (task === undefined ? [] : sessions.filter((session) => session.taskId === task.id)),
    [sessions, task],
  );
  const { layout, change, changeFor } = useTaskTabLayout(task, sessions);
  const taskId = task?.id;
  // Dialogs and async actions belong to their original task, even after the route changes.
  const taskIdRef = useRef(taskId);
  useLayoutEffect(() => {
    taskIdRef.current = taskId;
  }, [taskId]);
  const focusGroup = layout?.focused ?? "main";
  const setFocusGroup = useCallback(
    (group: TaskTabGroup) => change((current) => focusLayoutGroup(current, group)),
    [change],
  );
  const chatDrafts = useChatDrafts();
  const [pendingTabs, setPendingTabs] = useState<readonly PendingSessionTab[]>([]);
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
  // A terminal id whose tab was just added: the watch may not list it for a frame, and cleanup
  // must not treat that gap as "closed elsewhere".
  const pendingTerminals = useRef(new Set<string>());
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
  const terminalById = useMemo(
    () => new Map(terminals.map((terminal) => [terminal.id, terminal])),
    [terminals],
  );
  const labels = useMemo(() => sessionLabels(ofTask), [ofTask]);
  const mainTab = layout === undefined ? undefined : activeTab(layout, "main");
  const companionTab = layout === undefined ? undefined : activeTab(layout, "companion");
  const mainSession =
    mainTab?.kind === "session" ? sessionById.get(mainTab.sessionId ?? "") : undefined;
  const companionSession =
    companionTab?.kind === "session" ? sessionById.get(companionTab.sessionId ?? "") : undefined;
  const mainTerminal =
    mainTab?.kind === "terminal" ? terminalById.get(mainTab.terminalId ?? "") : undefined;
  const companionTerminal =
    companionTab?.kind === "terminal" ? terminalById.get(companionTab.terminalId ?? "") : undefined;
  const mainChat = useChatSession(client, mainSession);
  const companionChat = useChatSession(client, companionSession);
  const actionGroup = focusGroup;
  const focusedSession = actionGroup === "main" ? mainSession : companionSession;
  const focusedChat = actionGroup === "main" ? mainChat : companionChat;
  const focusedTab = layout === undefined ? undefined : activeTab(layout, focusGroup);
  const focusedTurn = useChatTurn(focusedChat?.store);

  const chatFor = (session: Session | undefined) =>
    session === undefined
      ? undefined
      : session.id === mainSession?.id
        ? mainChat
        : session.id === companionSession?.id
          ? companionChat
          : undefined;

  const chatFiles = useMemo<ChatFiles | undefined>(() => {
    if (task === undefined) return undefined;
    const owner = { id: task.id, primarySessionId: task.primarySessionId };
    const chatTaskId = task.id;
    return {
      resolve: async (paths) =>
        (await client.connection.api.files.resolve({ taskId: chatTaskId, paths: [...paths] }))
          .results,
      read: (path) => client.connection.api.files.read({ taskId: chatTaskId, path }),
      open: async (path, line, column) => {
        const opened = await client.connection.api.files.openEditor({
          taskId: chatTaskId,
          path,
          size: fitSize.current,
          ...(line === undefined ? {} : { line }),
          ...(column === undefined ? {} : { column }),
        });
        pendingTerminals.current.add(opened.terminalId);
        changeFor(owner, (current) =>
          addTab(current, {
            kind: "terminal",
            terminalId: opened.terminalId,
            group: current.focused,
          }),
        );
      },
    };
  }, [changeFor, client, task]);

  const report = useCallback(
    (error: unknown) => {
      setFailure(describeLaunchError(error) ?? describeError(error));
    },
    [setFailure],
  );

  const rememberFitSize = useCallback((size: TerminalSize) => {
    fitSize.current = size;
  }, []);

  // One request per action, through the shell's focus controller: the pane's input, a named tab,
  // or the group's Add control. The controller retries until React commits and gives up on input.
  const focusPane = useCallback((group: TaskTabGroup, tab?: string) => {
    requestAreaFocus({ area: group, prefer: "pane", tab });
  }, []);

  const focusTab = useCallback((id: string, group: TaskTabGroup) => {
    requestAreaFocus({ area: group, selector: `[data-tab-id="${CSS.escape(id)}"]` });
  }, []);

  const focusAddSession = useCallback((group: TaskTabGroup) => {
    requestAreaFocus({ area: group, selector: ADD_SESSION_SELECTOR });
  }, []);

  const addSession = useCallback(
    (session: Session, owner: Pick<Task, "id" | "primarySessionId">, group: TaskTabGroup) => {
      setPendingTabs((previous) => [...previous, { session, owner, group }]);
    },
    [],
  );

  // The RPC reply and sessions.watch are independent: reconcile only after the watch knows the
  // new session, or it can discard the requested group before that session is visible.
  useEffect(() => {
    const ready = pendingTabs.filter(({ session }) =>
      sessions.some((item) => item.id === session.id),
    );
    if (ready.length === 0) return;
    // oxlint-disable-next-line react/set-state-in-effect -- consume replies once the server watch sees them
    setPendingTabs((previous) => previous.filter((entry) => !ready.includes(entry)));
    for (const { session, owner, group } of ready) {
      changeFor(owner, (current) =>
        addTab(current, { kind: "session", sessionId: session.id, group }),
      );
      if (taskIdRef.current === owner.id) focusPane(group, `session:${session.id}`);
    }
  }, [changeFor, focusPane, pendingTabs, sessions]);

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
    async (
      kind: Session["kind"],
      choice?: AgentLaunchChoice,
      view?: SessionView,
      group: TaskTabGroup = focusGroup,
    ) => {
      if (task === undefined) return;
      const owner = { id: task.id, primarySessionId: task.primarySessionId };
      setFailure(undefined);
      try {
        const started = await launch(kind, choice, view);
        addSession(started, owner, group);
      } catch (error) {
        if (taskIdRef.current === owner.id) report(error);
      }
    },
    [addSession, focusGroup, launch, report, setFailure, task],
  );

  const openAgentPicker = useCallback(
    (group: TaskTabGroup = focusGroup) => {
      if (task === undefined) return;
      setFailure(undefined);
      setDialog({ kind: "pick-agent", group });
    },
    [focusGroup, setDialog, setFailure, task],
  );

  /**
   * Closing a tab. The primary session is not a closable view: removing it is the destructive
   * `Remove session…` path. Any other session's close ends its session first — a shell's process
   * group or a chat driver stops, a running turn is aborted — and only then removes the view. The
   * owning task is captured before the stop, so switching tasks during the abort grace still
   * closes that task's tab and leaves the task now on screen alone.
   */
  const close = useCallback(
    async (id: string) => {
      if (layout === undefined || task === undefined) return;
      const tab = layout.tabs.find((candidate) => tabId(candidate) === id);
      if (tab === undefined) return;
      if (tab.kind === "session" && tab.sessionId === task.primarySessionId) return;
      const owner = { id: task.id, primarySessionId: task.primarySessionId };
      const stillOnOwner = () => taskIdRef.current === owner.id;
      if (stillOnOwner()) setFailure(undefined);
      if (tab.kind === "session" && tab.sessionId !== undefined) {
        try {
          await client.connection.api.sessions.stop({ id: tab.sessionId });
        } catch (error) {
          if (stillOnOwner()) report(error);
          return;
        }
      }
      // A loose terminal is killed only while the server still lists it; one the watch has already
      // dropped leaves nothing to close, and the tab just goes.
      if (
        tab.kind === "terminal" &&
        tab.terminalId !== undefined &&
        terminals.some((candidate) => candidate.id === tab.terminalId)
      ) {
        try {
          await client.connection.api.terminals.close({ id: tab.terminalId });
        } catch (error) {
          if (stillOnOwner()) report(error);
          return;
        }
      }
      const after = closeTab(layout, id, owner.primarySessionId);
      if (after === layout) return;
      changeFor(owner, (current) => closeTab(current, id, owner.primarySessionId));
      // The owning task is closed either way; only the task on screen owns the keyboard and the
      // selection that the removal changes underneath it.
      if (!stillOnOwner()) return;
      const remaining = activeTab(after, tab.group);
      if (remaining !== undefined) {
        setFocusGroup(tab.group);
        focusPane(tab.group, tabId(remaining));
        return;
      }
      setFocusGroup(after.focused);
      const remainingGroup = activeTab(after, after.focused);
      if (remainingGroup !== undefined) focusPane(after.focused, tabId(remainingGroup));
      else focusAddSession(after.focused);
    },
    [
      changeFor,
      client,
      focusAddSession,
      focusPane,
      layout,
      report,
      setFailure,
      setFocusGroup,
      task,
      terminals,
    ],
  );

  const closeFocused = useCallback(() => {
    if (layout === undefined || task === undefined) return;
    const tab = activeTab(layout, focusGroup);
    if (tab === undefined) return;
    if (tab.kind === "session" && tab.sessionId === task.primarySessionId) {
      setFailure("The primary session is not a closable view; remove it with Remove session.");
      return;
    }
    void close(tabId(tab));
  }, [close, focusGroup, layout, setFailure, task]);

  // A shell whose process is gone is over: close its tab instead of leaving a stopped pane and a
  // restart notice. A failed launch keeps its tab, because that pane carries the reason the shell
  // never started. Agents keep their tab — it is the conversation and the way back into it.
  const closingExited = useRef(new Set<string>());
  useEffect(() => {
    if (task === undefined) return;
    for (const session of ofTask) {
      if (session.kind !== "shell" || session.id === task.primarySessionId) continue;
      if (closingExited.current.has(session.id)) continue;
      const terminal = terminals.find((candidate) => candidate.id === session.terminalId);
      const over =
        session.launchError == null && (session.state !== "running" || terminal?.exit != null);
      if (!over) continue;
      const tab = layout?.tabs.find(
        (candidate) => candidate.kind === "session" && candidate.sessionId === session.id,
      );
      if (tab === undefined) continue;
      closingExited.current.add(session.id);
      void close(tabId(tab));
    }
  }, [close, layout, ofTask, task, terminals]);

  // A loose terminal lives in the server's memory, not in the layout: once the watch no longer
  // lists one, its tab has nothing to show. A terminal this view just created is exempt for the
  // frame between `files.openEditor`'s reply and the watch that lists it.
  useEffect(() => {
    if (task === undefined || layout === undefined || !terminalsLoaded) return;
    const present = new Set(terminals.map((terminal) => terminal.id));
    for (const terminalId of pendingTerminals.current) {
      if (present.has(terminalId)) pendingTerminals.current.delete(terminalId);
    }
    const stale = layout.tabs.filter(
      (tab) =>
        tab.kind === "terminal" &&
        tab.terminalId !== undefined &&
        !present.has(tab.terminalId) &&
        !pendingTerminals.current.has(tab.terminalId),
    );
    if (stale.length === 0) return;
    const owner = { id: task.id, primarySessionId: task.primarySessionId };
    changeFor(owner, (current) =>
      stale.reduce((next, tab) => closeTab(next, tabId(tab), owner.primarySessionId), current),
    );
  }, [changeFor, layout, task, terminals, terminalsLoaded]);

  const select = useCallback(
    (id: string) => {
      if (layout === undefined) return;
      const tab = layout.tabs.find((candidate) => tabId(candidate) === id);
      if (tab === undefined) return;
      setFailure(undefined);
      change((current) => selectTab(current, id));
      setFocusGroup(tab.group);
      focusPane(tab.group, id);
    },
    [change, focusPane, layout, setFailure, setFocusGroup],
  );

  const moveTo = useCallback(
    (id: string, group: TaskTabGroup, index?: number) => {
      if (layout === undefined) return;
      const after = moveTab(layout, id, group, index);
      if (after === layout) return;
      setFailure(undefined);
      change((current) => moveTab(current, id, group, index));
      focusTab(id, group);
    },
    [change, focusTab, layout, setFailure],
  );

  const move = useCallback(() => {
    if (layout === undefined) return;
    const tab = activeTab(layout, focusGroup);
    if (tab === undefined) return;
    moveTo(tabId(tab), tab.group === "main" ? "companion" : "main");
  }, [focusGroup, layout, moveTo]);

  const dropTab = useCallback(
    (drop: VisualTabDrop) => {
      if (layout === undefined || drop.id === drop.over) return;
      const items = tabsInGroup(layout, drop.group).filter((tab) => tabId(tab) !== drop.id);
      const over = items.findIndex((tab) => tabId(tab) === drop.over);
      const index = over < 0 ? items.length : over + (drop.after ? 1 : 0);
      moveTo(drop.id, drop.group, index);
    },
    [layout, moveTo],
  );

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
    async (session: Session, origin: DialogOrigin = "key") => {
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
          origin,
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
      if (layout === undefined) return;
      // Focus follows the view that takes the removed one's place: the next tab in its group,
      // the other group when that one is now empty, or the add control when nothing is left.
      const group = layout.tabs.find(
        (tab) => tab.kind === "session" && tab.sessionId === session.id,
      )?.group;
      const after = removeSession(layout, session.id);
      change((current) => removeSession(current, session.id));
      if (group === undefined) return;
      const next = activeTab(after, group);
      if (next !== undefined) {
        setFocusGroup(group);
        focusPane(group, tabId(next));
        return;
      }
      const other = group === "main" ? "companion" : "main";
      const nextOther = activeTab(after, other);
      if (nextOther !== undefined) {
        setFocusGroup(other);
        focusPane(other, tabId(nextOther));
        return;
      }
      focusAddSession(after.focused);
    },
    [change, client, focusAddSession, focusPane, layout, setDialog, setFailure, setFocusGroup],
  );

  const toggleGroup = useCallback(
    (group: TaskTabGroup = focusGroup) => {
      if (layout === undefined) return;
      const next = toggleExpanded(layout, group);
      if (next === layout) return;
      change((current) => toggleExpanded(current, group));
      const selected = activeTab(layout, group);
      focusPane(group, selected === undefined ? undefined : tabId(selected));
    },
    [change, focusGroup, focusPane, layout],
  );

  const focusCompanion = useCallback(() => {
    if (layout === undefined) return;
    const other = focusGroup === "companion" ? "main" : "companion";
    const tab = activeTab(layout, other) ?? tabsInGroup(layout, other)[0];
    if (tab === undefined) return;
    change((current) => focusLayoutGroup(current, other));
    focusPane(other, tabId(tab));
  }, [change, focusGroup, focusPane, layout]);

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
      else if (action === "switch-view") switchActive();
      else if (action === "close-tab") closeFocused();
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
        setDialog({ kind: "remove-session", session: focusedSession, origin: "key" });
      else if (action === "rename-session" && focusedSession !== undefined)
        setDialog({
          kind: "rename",
          target: {
            type: "session",
            id: focusedSession.id,
            name: labels.get(focusedSession.id) ?? focusedSession.kind,
            value: focusedSession.label ?? "",
          },
          origin: "key",
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
      openModelPicker,
      openReasoningPicker,
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
      "switch-view",
      "close-tab",
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

  const companionWidth = companionWidthFor(
    layout?.companionWidth ?? COMPANION_DEFAULT_WIDTH,
    available,
  );
  const companionLimits = companionRange(available);
  // The handle starts from the rendered width; store the value the frame can actually show.
  const resizeCompanion = useCallback(
    (next: number) => {
      const width = Math.max(companionLimits.min, Math.min(companionLimits.max, Math.round(next)));
      change((current) =>
        current.companionWidth === width ? current : { ...current, companionWidth: width },
      );
    },
    [change, companionLimits.max, companionLimits.min],
  );

  const mainHasTabs = layout !== undefined && tabsInGroup(layout, "main").length > 0;
  const companionHasTabs = layout !== undefined && tabsInGroup(layout, "companion").length > 0;
  const mainVisible = !companionHasTabs || (mainHasTabs && layout?.expanded !== "companion");
  const companionVisible = companionHasTabs && (!mainHasTabs || layout?.expanded !== "main");
  const sessionItems = (group: TaskTabGroup): VisualTabItem[] => {
    if (layout === undefined) return [];
    const paneId = group === "main" ? MAIN_PANE_ID : COMPANION_PANE_ID;
    return tabsInGroup(layout, group).flatMap((tab): VisualTabItem[] => {
      const id = tabId(tab);
      const groupTabs = tabsInGroup(layout, group);
      const index = groupTabs.findIndex((candidate) => tabId(candidate) === id);
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
                {session.state === "running" && session.id === task?.primarySessionId ? (
                  <DropdownMenuItem onClick={() => void stopSession(session)}>
                    Stop {label}
                  </DropdownMenuItem>
                ) : session.state !== "running" ? (
                  <DropdownMenuItem onClick={() => void restartSession(session)}>
                    {described.action ?? "Restart"} {label}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  disabled={"reason" in offer}
                  title={"reason" in offer ? offer.reason : undefined}
                  onClick={() => void switchSession(session, "menu")}
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
                      origin: "menu",
                    })
                  }
                >
                  Rename…
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={index === 0}
                  onClick={() => moveTo(id, group, index - 1)}
                >
                  Move tab left
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={index === groupTabs.length - 1}
                  onClick={() => moveTo(id, group, index + 1)}
                >
                  Move tab right
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => moveTo(id, group === "main" ? "companion" : "main")}
                >
                  Move tab to the other group
                </DropdownMenuItem>
                {session.id !== task?.primarySessionId && (
                  <DropdownMenuItem onClick={() => void close(id)}>Close tab</DropdownMenuItem>
                )}
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setDialog({ kind: "remove-session", session, origin: "menu" })}
                >
                  Remove session…
                </DropdownMenuItem>
              </>
            ),
          },
        ];
      }
      if (tab.kind === "terminal") {
        const terminal =
          tab.terminalId === undefined ? undefined : terminalById.get(tab.terminalId);
        if (terminal === undefined) return [];
        const label = terminalLabel(terminal);
        return [
          {
            id,
            kind: "terminal" as const,
            label,
            menuLabel: `Terminal actions for ${label}`,
            selected: layout.active[group] === id,
            canClose: true,
            title: terminal.exit === null ? label : `${label} · exited`,
            paneId,
            menu: (
              <>
                <DropdownMenuItem
                  disabled={index === 0}
                  onClick={() => moveTo(id, group, index - 1)}
                >
                  Move tab left
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={index === groupTabs.length - 1}
                  onClick={() => moveTo(id, group, index + 1)}
                >
                  Move tab right
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => moveTo(id, group === "main" ? "companion" : "main")}
                >
                  Move tab to the other group
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void close(id)}>Close terminal</DropdownMenuItem>
              </>
            ),
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

  const addSessionTooltip = `Add session · ${formatBinding(config, "new-terminal")} / ${formatBinding(config, "new-agent")}`;
  const addSessionControl = (group: TaskTabGroup) => (
    <VisualAddMenu
      label="Add session"
      menuLabel="New agent session"
      tooltip={addSessionTooltip}
      onAdd={() => void startSession("shell", undefined, undefined, group)}
    >
      <DropdownMenuItem onClick={() => openAgentPicker(group)}>Agent…</DropdownMenuItem>
    </VisualAddMenu>
  );
  const emptyAddSessionControl = (
    <VisualAddMenu label="Add session" tooltip={addSessionTooltip}>
      <DropdownMenuItem onClick={() => void startSession("shell", undefined, undefined, "main")}>
        Shell
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => openAgentPicker("main")}>Agent…</DropdownMenuItem>
    </VisualAddMenu>
  );

  const strip = (group: TaskTabGroup) => (
    <VisualTabStrip
      label={group === "main" ? "Sessions" : "Companion tabs"}
      items={sessionItems(group)}
      position={position}
      onSelect={select}
      onClose={(id) => close(id)}
      dragGroup={group}
      add={addSessionControl(group)}
      actions={
        mainHasTabs && companionHasTabs ? (
          <VisualIconButton
            label={layout?.expanded === group ? "Restore panel size" : "Maximize panel"}
            icon={layout?.expanded === group ? "minimize" : "maximize"}
            onClick={() => toggleGroup(group)}
          />
        ) : undefined
      }
    />
  );

  const sessionPane = (session: Session | undefined, group: TaskTabGroup): ReactNode => {
    if (session === undefined) return null;
    const chat = chatFor(session);
    const terminal = terminals.find((candidate) => candidate.id === session.terminalId);
    // The exit effect closes this tab; render nothing for the frame before it does. A failed
    // launch keeps its stopped pane, which is where the reason is shown.
    const shellOver =
      session.kind === "shell" &&
      session.launchError == null &&
      (session.state !== "running" || terminal?.exit != null);
    if (shellOver) return null;
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
          draft={chatDrafts.get(session.id)}
          autoFocus={focusGroup === group && (group === "main" ? mainVisible : companionVisible)}
          onDraftChange={(update) => chatDrafts.change(session.id, update)}
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
          autoFocus={focusGroup === group && (group === "main" ? mainVisible : companionVisible)}
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
          onRestart={() => void restartSession(session)}
        />
      );
    }
    return null;
  };

  const terminalPane = (terminal: TerminalInfo, group: TaskTabGroup) => (
    <TerminalView
      key={terminal.id}
      client={client}
      terminal={terminal}
      onFit={rememberFitSize}
      autoFocus={focusGroup === group && (group === "main" ? mainVisible : companionVisible)}
    />
  );

  const groupPane = (group: TaskTabGroup) => {
    const selected = group === "main" ? mainTab : companionTab;
    const session = group === "main" ? mainSession : companionSession;
    const terminal = group === "main" ? mainTerminal : companionTerminal;
    return (
      <>
        {position === "top" && strip(group)}
        <VisualTabPanel
          id={group === "main" ? MAIN_PANE_ID : COMPANION_PANE_ID}
          labelledBy={selected === undefined ? undefined : `tab-${tabId(selected)}`}
          fill
          panelRef={group === "main" ? mainPane : companionPane}
        >
          <div className="visual-workspace-pane">
            {selected === undefined && group === "main" && !companionHasTabs ? (
              <div className="visual-main-empty visual-workspace-empty">
                {emptyAddSessionControl}
              </div>
            ) : selected?.kind === "terminal" ? (
              terminal === undefined ? null : (
                terminalPane(terminal, group)
              )
            ) : (
              sessionPane(session, group)
            )}
          </div>
        </VisualTabPanel>
        {position === "bottom" && strip(group)}
      </>
    );
  };

  // A menu-opened dialog returns to its tab; a keyboard-opened one lets Base UI return to the
  // pane that had the keyboard, which is where a chord leaves it.
  const tabFocus = (sessionId: string): HTMLElement | null => {
    const tab = layout?.tabs.find(
      (candidate) => candidate.kind === "session" && candidate.sessionId === sessionId,
    );
    const group = tab?.group ?? focusGroup;
    return (
      document.querySelector<HTMLElement>(
        `[data-tab-id="${CSS.escape(`session:${sessionId}`)}"]`,
      ) ?? groupFallback(group)
    );
  };
  const targetFocus = (target: RenameTarget): HTMLElement | null => {
    if (target.type === "session") return tabFocus(target.id);
    if (target.type === "terminal")
      return (
        document.querySelector<HTMLElement>(
          `[data-tab-id="${CSS.escape(`terminal:${target.id}`)}"]`,
        ) ?? groupFallback(focusGroup)
      );
    return null;
  };

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
              addSession(started, task, dialog.group);
              if (taskIdRef.current === task.id) setDialog(undefined);
            }}
            onClose={() => setDialog(undefined)}
          />
        )}
        {dialog?.kind === "remove-session" && (
          <RemoveSessionDialog
            session={dialog.session}
            finalFocus={
              dialog.origin === "menu"
                ? () => firstFocusable(tabFocus(dialog.session.id)) ?? false
                : undefined
            }
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
            finalFocus={
              dialog.origin === "menu"
                ? () => firstFocusable(tabFocus(dialog.session.id)) ?? false
                : undefined
            }
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
                store={chat.store}
                kind={dialog.kind === "chat-model" ? "model" : "reasoning"}
                agent={dialog.session.kind}
                launch={dialog.session.launch}
                profiles={profiles}
                agents={config.agents}
                levelsSupported={
                  drivers.find((driver) => driver.kind === dialog.session.kind)?.reasoningLevels ??
                  false
                }
                modelSwitchSupported={
                  drivers.find((driver) => driver.kind === dialog.session.kind)?.modelSwitch ??
                  false
                }
                anchor={
                  dialog.session.id === companionSession?.id
                    ? dialog.kind === "chat-model"
                      ? companionModelAnchor
                      : companionReasoningAnchor
                    : dialog.kind === "chat-model"
                      ? mainModelAnchor
                      : mainReasoningAnchor
                }
                onSetModel={chat.setModel}
                onSetReasoning={chat.setReasoning}
                onClose={() => setDialog(undefined)}
              />
            );
          })()}
        {dialog?.kind === "rename" && (
          <RenameDialog
            target={dialog.target}
            finalFocus={
              dialog.origin === "menu"
                ? () => firstFocusable(targetFocus(dialog.target)) ?? false
                : undefined
            }
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

  const focusedSessionCount =
    layout === undefined
      ? 0
      : tabsInGroup(layout, focusGroup).filter((tab) => tab.kind === "session").length;
  // `focus-companion` moves to the other group; with no tabs there, its chord would be silent.
  const otherGroupTabs =
    layout === undefined
      ? 0
      : tabsInGroup(layout, focusGroup === "main" ? "companion" : "main").length;
  const goToSession = (number: number): ActionAvailability => {
    if (layout !== undefined && sessionTabAt(layout, focusGroup, number) !== undefined)
      return { enabled: true };
    return focusedSessionCount === 0
      ? availabilityOf(false, "This task has no sessions.")
      : availabilityOf(
          false,
          `This task has only ${focusedSessionCount} session${focusedSessionCount === 1 ? "" : "s"}.`,
        );
  };
  const offeredView: { reason: string } | { target: SessionView } =
    focusedSession === undefined
      ? { reason: "Select an agent session." }
      : viewOffer(focusedSession, drivers, capabilitiesReady);
  const actionAvailability: Partial<Record<ActionId, ActionAvailability>> = {
    "new-terminal": availabilityOf(hasTask, "Select a task first."),
    "new-agent": availabilityOf(hasTask, "Select a task first."),
    "stop-session":
      focusedSession === undefined
        ? availabilityOf(false, "Select a running session to stop.")
        : availabilityOf(focusedSession.state === "running", "This session is not running."),
    "restart-session":
      focusedSession === undefined
        ? availabilityOf(false, "Select a session to restart.")
        : availabilityOf(
            focusedSession.state !== "running",
            "This session is running; stop it first.",
          ),
    "rename-session": availabilityOf(focusedSession !== undefined, "Select a session to rename."),
    "remove-session": availabilityOf(focusedSession !== undefined, "Select a session to remove."),
    "next-session": availabilityOf(
      layout !== undefined && stepTab(layout, focusGroup, 1) !== undefined,
      "This task has fewer than two sessions.",
    ),
    "previous-session": availabilityOf(
      layout !== undefined && stepTab(layout, focusGroup, -1) !== undefined,
      "This task has fewer than two sessions.",
    ),
    "abort-turn":
      focusedChat === undefined
        ? availabilityOf(false, "Only a running chat session has a turn to abort.")
        : focusedChat.aborting
          ? availabilityOf(false, "This turn is stopping.")
          : availabilityOf(focusedTurn === "working", "No turn is working in this chat session."),
    "change-model": availabilityOf(
      focusedChat !== undefined,
      "Only a running chat session has a model control.",
    ),
    "change-reasoning": availabilityOf(
      focusedChat !== undefined,
      "Only a running chat session has a reasoning control.",
    ),
    "switch-view":
      "target" in offeredView ? { enabled: true } : availabilityOf(false, offeredView.reason),
    "close-tab": availabilityOf(focusedTab !== undefined, "Select an agent session."),
    "toggle-companion": { enabled: true },
    "move-tab": availabilityOf(focusedTab !== undefined, "Select an agent session."),
    "focus-companion": availabilityOf(otherGroupTabs > 0, "The other group has no tabs."),
    "session-1": goToSession(1),
    "session-2": goToSession(2),
    "session-3": goToSession(3),
    "session-4": goToSession(4),
    "session-5": goToSession(5),
    "session-6": goToSession(6),
    "session-7": goToSession(7),
    "session-8": goToSession(8),
    "session-9": goToSession(9),
  };

  return {
    notice:
      failure === undefined && !chatDrafts.storageFailed ? null : (
        <p className="visual-workspace-alert" role="alert">
          {failure ?? DRAFT_STORAGE_NOTICE}
        </p>
      ),
    main:
      layout === undefined ? null : (
        <VisualWorkspaceGroups
          // oxlint-disable-next-line react/refs -- the group passes pane refs to its children
          main={groupPane("main")}
          // oxlint-disable-next-line react/refs -- the group passes pane refs to its children
          companion={groupPane("companion")}
          mainVisible={mainVisible}
          companionVisible={companionVisible}
          expanded={layout.expanded}
          width={companionWidth}
          min={companionLimits.min}
          max={companionLimits.max}
          onResize={resizeCompanion}
          onFocusGroup={setFocusGroup}
          onDrop={dropTab}
        />
      ),
    dialogs,
    prefix,
    prefixEnabled: active && dialog === undefined,
    actionAvailability,
  };
}
