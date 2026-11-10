import { sessionStatus } from "@corral/client/agent-status";
import type { CorralClient } from "@corral/client/corral-client";
import { describeError, SETTLED_TASK_MESSAGE } from "@corral/client/rpc-errors";
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
import { ChatChoiceDialog, ChatView, useChatSession, type ChatFiles } from "../chat/index.ts";
import { formatBinding, bindingOf } from "../keymap/index.ts";
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
  const [focusGroup, setFocusGroup] = useState<TaskTabGroup>("main");
  const [chatDrafts, setChatDrafts] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [dialog, setDialog] = useState<DialogState>();
  const [failure, setFailure] = useState<string>();
  const fitSize = useRef<TerminalSize>(DEFAULT_SIZE);
  const mainPane = useRef<HTMLDivElement>(null);
  const companionPane = useRef<HTMLDivElement>(null);
  const modelAnchor = useRef<HTMLButtonElement>(null);
  const reasoningAnchor = useRef<HTMLButtonElement>(null);
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
  const focusedSession = focusGroup === "main" ? mainSession : companionSession;
  const focusedChat = focusGroup === "main" ? mainChat : companionChat;

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
    (taskId) => (task?.id === taskId ? changesActions : undefined),
    task === undefined ? [] : [task.id],
  );

  const chatFiles = useMemo<ChatFiles | undefined>(() => {
    if (task === undefined) return undefined;
    const taskId = task.id;
    return {
      resolve: async (paths) =>
        (await client.connection.api.files.resolve({ taskId, paths: [...paths] })).results,
      read: (path) => client.connection.api.files.read({ taskId, path }),
      open: async (path, line, column) => {
        await client.connection.api.files.openEditor({
          taskId,
          path,
          size: fitSize.current,
          ...(line === undefined ? {} : { line }),
          ...(column === undefined ? {} : { column }),
        });
      },
    };
  }, [client, task]);

  const report = useCallback((error: unknown) => {
    setFailure(describeLaunchError(error) ?? describeError(error));
  }, []);

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

  const addSession = useCallback(
    (session: Session) => {
      change((current) =>
        addTab(current, { kind: "session", sessionId: session.id, group: "main" }),
      );
      setFocusGroup("main");
      focusPane("main");
    },
    [change, focusPane],
  );

  /** Starts the session and leaves the tab to the caller, so a picker can show its own refusal. */
  const launch = useCallback(
    async (
      kind: Session["kind"],
      choice?: AgentLaunchChoice,
      view?: SessionView,
    ): Promise<Session> => {
      if (task === undefined) throw new Error("Select a task first.");
      if (task.state === "settled") throw new Error(SETTLED_TASK_MESSAGE);
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
      if (task?.state === "settled") {
        setFailure(SETTLED_TASK_MESSAGE);
        return;
      }
      setFailure(undefined);
      try {
        const started = await launch(kind, choice, view);
        addSession(started);
      } catch (error) {
        report(error);
      }
    },
    [addSession, launch, report, task?.state],
  );

  const openAgentPicker = useCallback(() => {
    if (task === undefined) return;
    if (task.state === "settled") {
      setFailure(SETTLED_TASK_MESSAGE);
      return;
    }
    setFailure(undefined);
    setDialog({ kind: "pick-agent" });
  }, [task]);

  const openChanges = useCallback(() => {
    setFailure(undefined);
    change((current) => addTab(current, { kind: "changes", group: "companion" }));
    setFocusGroup("companion");
    focusPane("companion");
  }, [change, focusPane]);

  const closeFocused = useCallback(() => {
    if (layout === undefined || task === undefined) return;
    const tab = activeTab(layout, focusGroup);
    if (tab === undefined) return;
    const id = tabId(tab);
    change((current) => closeTab(current, id, task.primarySessionId));
    const after = closeTab(layout, id, task.primarySessionId);
    const remaining = activeTab(after, focusGroup);
    if (remaining !== undefined) focusTab(tabId(remaining));
    else {
      setFocusGroup("main");
      focusPane("main");
    }
  }, [change, focusGroup, focusPane, focusTab, layout, task]);

  const reopen = useCallback(() => {
    if (layout === undefined || task === undefined) return;
    const after = reopenLast(layout, task, ofTask);
    if (after === layout) return;
    change((current) => reopenLast(current, task, ofTask));
    const group: TaskTabGroup =
      after.active.companion !== layout.active.companion ? "companion" : "main";
    setFocusGroup(group);
    const tab = activeTab(after, group);
    if (tab !== undefined) focusTab(tabId(tab));
    focusPane(group);
  }, [change, focusPane, focusTab, layout, ofTask, task]);

  const select = useCallback(
    (id: string) => {
      if (layout === undefined) return;
      const tab = layout.tabs.find((candidate) => tabId(candidate) === id);
      if (tab === undefined) return;
      change((current) => selectTab(current, id));
      setFocusGroup(tab.group);
      focusPane(tab.group);
    },
    [change, focusPane, layout],
  );

  const close = useCallback(
    (id: string) => {
      if (layout === undefined || task === undefined) return;
      const tab = layout.tabs.find((candidate) => tabId(candidate) === id);
      if (tab === undefined) return;
      const after = closeTab(layout, id, task.primarySessionId);
      if (after === layout) return;
      change((current) => closeTab(current, id, task.primarySessionId));
      if (tab.group === focusGroup) {
        const remaining = activeTab(after, focusGroup);
        if (remaining !== undefined) focusTab(tabId(remaining));
        else {
          setFocusGroup("main");
          focusPane("main");
        }
      }
    },
    [change, focusGroup, focusPane, focusTab, layout, task],
  );

  const move = useCallback(() => {
    if (layout === undefined) return;
    const tab = activeTab(layout, focusGroup);
    if (tab === undefined) return;
    const after = moveTab(layout, tabId(tab));
    if (after === layout) return;
    change((current) => moveTab(current, tabId(tab)));
    const group: TaskTabGroup = tab.group === "main" ? "companion" : "main";
    setFocusGroup(group);
    focusPane(group);
  }, [change, focusGroup, focusPane, layout]);

  const step = useCallback(
    (direction: 1 | -1) => {
      if (layout === undefined) return;
      const tab = stepTab(layout, focusGroup, direction);
      if (tab === undefined) return;
      select(tabId(tab));
    },
    [focusGroup, layout, select],
  );

  const selectNumber = useCallback(
    (number: number) => {
      if (layout === undefined) return;
      const tab = sessionTabAt(layout, focusGroup, number);
      if (tab !== undefined) select(tabId(tab));
    },
    [focusGroup, layout, select],
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
    [client, companionSession, focusPane, report],
  );

  const switchActive = useCallback(async () => {
    if (focusedSession === undefined) {
      setFailure("Select an agent session.");
      return;
    }
    const session = focusedSession;
    if (session.kind === "shell") {
      setFailure("A shell runs in a terminal only.");
      return;
    }
    if (!capabilitiesReady) {
      setFailure("Waiting for the server's chat drivers.");
      return;
    }
    const driver = drivers.find((candidate) => candidate.kind === session.kind);
    if (driver === undefined) {
      setFailure(`The ${session.kind} agent has no chat driver in this build.`);
      return;
    }
    const target: SessionView = session.view === "chat" ? "terminal" : "chat";
    const live = driver.terminalView === "both-live";
    const chat =
      session.id === mainSession?.id
        ? mainChat
        : session.id === companionSession?.id
          ? companionChat
          : undefined;
    const working =
      session.view === "chat"
        ? (chat?.store.getSnapshot().state.turn ?? "idle") === "working"
        : ["working", "blocked"].includes(sessionStatus(session)?.state ?? "");
    const waiting =
      session.view === "chat"
        ? (chat?.store
            .getSnapshot()
            .items.some((item) => item.kind === "user-request" && item.status === "pending") ??
          false)
        : sessionStatus(session)?.state === "blocked";
    if (!live && (working || waiting)) {
      setDialog({ kind: "switch-view", session, target, working, waiting });
      return;
    }
    await setView(session, target);
  }, [
    capabilitiesReady,
    companionChat,
    companionSession?.id,
    drivers,
    focusedSession,
    mainChat,
    mainSession?.id,
    setView,
  ]);

  const stopSession = useCallback(
    async (session: Session) => {
      setFailure(undefined);
      try {
        await client.connection.api.sessions.stop({ id: session.id });
      } catch (error) {
        report(error);
      }
    },
    [client, report],
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
    [client, companionSession, focusPane, report],
  );

  const remove = useCallback(
    async (session: Session) => {
      setFailure(undefined);
      await client.connection.api.sessions.remove({ id: session.id });
      setDialog(undefined);
      change((current) => removeSession(current, session.id));
      if (tabsInGroup({ tabs: layout?.tabs ?? [] }, "companion").length === 0)
        setFocusGroup("main");
    },
    [change, client, layout],
  );

  const toggleGroup = useCallback(() => {
    if (layout === undefined) return;
    const next = toggleCompanion(layout);
    change((current) => toggleCompanion(current));
    setFocusGroup(next.companionOpen ? "companion" : "main");
    if (next.companionOpen) focusPane("companion");
    else focusPane("main");
  }, [change, focusPane, layout]);

  const focusCompanion = useCallback(() => {
    if (layout === undefined || tabsInGroup(layout, "companion").length === 0) return;
    const tab = activeTab(layout, "companion") ?? tabsInGroup(layout, "companion")[0];
    if (tab === undefined) return;
    change((current) => selectTab({ ...current, companionOpen: true }, tabId(tab)));
    setFocusGroup("companion");
    focusPane("companion");
  }, [change, focusPane, layout]);

  const abort = useCallback(async () => {
    if (focusedChat === undefined) return;
    setFailure(undefined);
    try {
      await focusedChat.abort();
    } catch (error) {
      report(error);
    }
  }, [focusedChat, report]);

  const openModelPicker = useCallback(() => {
    if (focusedSession === undefined || focusedChat === undefined) {
      setFailure("Only a running chat session has a model control.");
      return;
    }
    setDialog({ kind: "chat-model", session: focusedSession });
  }, [focusedChat, focusedSession]);
  const openReasoningPicker = useCallback(() => {
    if (focusedSession === undefined || focusedChat === undefined) {
      setFailure("Only a running chat session has a reasoning control.");
      return;
    }
    setDialog({ kind: "chat-reasoning", session: focusedSession });
  }, [focusedChat, focusedSession]);

  const runAction = useCallback(
    (action: string) => {
      if (action === "new-terminal") void startSession("shell");
      else if (action === "new-agent") openAgentPicker();
      else if (action === "changes") openChanges();
      else if (action === "switch-view") void switchActive();
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
      else if (action === "change-model") openModelPicker();
      else if (action === "change-reasoning") openReasoningPicker();
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
      switchActive,
      toggleGroup,
    ],
  );

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
        return [
          {
            id,
            kind: "session" as const,
            label,
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
      <VisualAddMenu label="Add session">
        <DropdownMenuItem onClick={() => void startSession("shell")}>Shell</DropdownMenuItem>
        <DropdownMenuItem onClick={openAgentPicker}>Agent…</DropdownMenuItem>
      </VisualAddMenu>
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

  const sessionPane = (session: Session | undefined): ReactNode => {
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
          modelPickerAnchor={modelAnchor}
          reasoningPickerAnchor={reasoningAnchor}
          canChooseAgent={Object.values(config.agents).some((agent) => agent.enabled.value)}
          abortHint={formatBinding(config, "abort-turn")}
          aborting={chat.aborting}
          onSend={chat.send}
          onAbort={chat.abort}
          onRespond={chat.respond}
          onChangeModel={openModelPicker}
          onChangeReasoning={openReasoningPicker}
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
          taskState={task?.state}
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
        {failure !== undefined && (
          <p className="visual-workspace-alert" role="alert">
            {failure}
          </p>
        )}
        {/* oxlint-disable-next-line react/refs -- the anchors are passed to ChatView, not read here */}
        <div className="visual-workspace-pane">{sessionPane(mainSession)}</div>
      </VisualTabPanel>
    );

  const companionPaneContent =
    layout === undefined || tabsInGroup(layout, "companion").length === 0 ? null : (
      <VisualCompanion
        open={layout.companionOpen}
        width={companionWidth}
        min={companionLimits.min}
        max={companionLimits.max}
        onResize={setPreferredWidth}
        label="Resize companion group"
      >
        {position === "top" && strip("companion")}
        <VisualTabPanel
          id={COMPANION_PANE_ID}
          labelledBy={companionTab === undefined ? undefined : `tab-${tabId(companionTab)}`}
          fill
          panelRef={companionPane}
        >
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
            sessionPane(companionSession)
          )}
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
                anchor={dialog.kind === "chat-model" ? modelAnchor : reasoningAnchor}
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

  return {
    chrome: position === "top" ? strip("main") : null,
    main: (
      <>
        {mainPaneContent}
        {position === "bottom" && strip("main")}
      </>
    ),
    companion: companionPaneContent,
    dialogs,
    prefix:
      task === undefined
        ? { bindings: {}, onAction: () => undefined }
        : { bindings, onAction: runAction },
    prefixEnabled: active && dialog === undefined,
  };
}
