import { describeSessionState } from "@corral/client/session-state";
import { describeError, SETTLED_TASK_MESSAGE } from "@corral/client/rpc-errors";
import type { WatchFailure } from "@corral/client/watch-store";
import { ActionId, taskSettingsFor, type ClientConfig } from "@corral/protocol/config";
import type { SessionView } from "@corral/protocol/rpc";
import { useCallback, useRef, useState } from "react";
import {
  AppShell,
  Button,
  IconButton,
  Input,
  MainPanel,
  SidebarPanel,
  TaskContent,
} from "../../common/ui/index.ts";
import { ChangesView } from "../changes/index.ts";
import { AddProjectDialog } from "../projects/index.ts";
import { ChatChoiceDialog, ChatView } from "../chat/index.ts";
import {
  AgentPicker,
  RemoveSessionDialog,
  StoppedSession,
  SwitchViewDialog,
} from "../sessions/index.ts";
import {
  NewTaskView,
  RemoveProjectDialog,
  RemoveTaskDialog,
  TaskSourceDialog,
} from "../tasks/index.ts";
import { TerminalView } from "../terminal/index.ts";
import {
  ConnectionRecoveryDialog,
  putCapabilityInHash,
  StartupNotice,
  type NoticeProblem,
} from "../connection/index.ts";
import { CommandPaletteDialog, ConfigProblemsDialog, formatBinding } from "../keymap/index.ts";
import { useAppearance, useSettingsActivity } from "../settings/index.ts";
import { FindTaskDialog } from "./find-task-dialog.tsx";
import { RenameDialog } from "./rename-dialog.tsx";
import { SessionTabs } from "./session-tabs.tsx";
import { Sidebar } from "./sidebar.tsx";
import { ADD_PROJECT_BUTTON_ID } from "./sidebar-focus.ts";
import { ShellStatus } from "./shell-status.tsx";
import { SidebarResizeHandle } from "./sidebar-resize-handle.tsx";
import { TaskHeader } from "./task-header.tsx";
import { useWorkspace } from "./use-workspace.ts";
import type { WorkspaceSearch } from "./workspace-search.ts";

function keyHint(config: ClientConfig, action: ActionId): string | undefined {
  return config.keys.bindings[action] === null ? undefined : formatBinding(config, action);
}

function pressHint(config: ClientConfig, action: ActionId): string | undefined {
  const key = keyHint(config, action);
  return key === undefined ? undefined : `Press ${key}.`;
}

export interface WorkspaceScreenProps {
  active?: boolean;
  search: WorkspaceSearch;
  onChange: (search: WorkspaceSearch) => void;
  onOpenBoard: (search: WorkspaceSearch) => void;
  onOpenSettings: (search: WorkspaceSearch) => void;
}

/**
 * The workspace shell (`layout.md`, **Shell**): a resizable sidebar of tasks and a main area that
 * shows one task — header, its sessions as tabs and the selected session's terminal — or the
 * empty states.
 */
export function WorkspaceScreen({
  active = true,
  search,
  onChange,
  onOpenBoard,
  onOpenSettings,
}: WorkspaceScreenProps) {
  const { appearance } = useAppearance();
  const settingsActivity = useSettingsActivity();
  const agentPickerAnchor = useRef<HTMLButtonElement>(null);
  const modelPickerAnchor = useRef<HTMLButtonElement>(null);
  const reasoningPickerAnchor = useRef<HTMLButtonElement>(null);
  const [chatDrafts, setChatDrafts] = useState<ReadonlyMap<string, string>>(new Map());
  const {
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
    capabilitiesReady,
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
    dialog,
    composing,
    composerDraft,
    setComposerDraft,
    failure,
    dismissFailure,
    armed,
    actions,
    invoke,
    rememberFitSize,
    choose,
    showTask,
    openTask,
    continueTask,
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
    renameEntry,
    selectEntry,
    toggleSettle,
    openNewTask,
    closeNewTask,
    loadBranches,
    openRemoveTask,
    closeRemoveTask,
    openRemoveProject,
    openRemoveSession,
    openTaskSource,
    openFindTask,
    openConfigProblems,
    openConnectionRecovery,
    addProject,
    createTask,
    resolveIssue,
    removeTask,
    removeProject,
    setDialog,
  } = useWorkspace({
    active: active && !settingsActivity?.open,
    search,
    onChange,
    onOpenBoard,
    onOpenSettings,
  });
  const browse = useCallback(
    (path: string, signal: AbortSignal) =>
      client.connection.api.projects.directories({ path }, { signal }),
    [client],
  );
  // A first attempt that has not failed yet is a normal load; after that, every retry keeps
  // the boot notice up instead of flashing an empty workspace between attempts.
  const startupProblem: NoticeProblem | undefined =
    connection.status === "disconnected"
      ? {
          kind: "unreachable",
          attempt: connection.attempt,
          startedAt: connection.startedAt,
          serverUrl: client.server.url,
        }
      : connection.status === "capability-refused"
        ? {
            kind: "capability-refused",
            attempt: connection.attempt,
            startedAt: connection.startedAt,
            serverUrl: client.server.url,
          }
        : connection.status === "invalid-capability"
          ? {
              kind: "invalid-capability",
              detail: connection.detail,
              serverUrl: client.server.url,
            }
          : connection.status === "connecting" && connection.attempt > 1
            ? {
                kind: "unreachable",
                attempt: connection.attempt,
                startedAt: connection.startedAt,
                serverUrl: client.server.url,
              }
            : undefined;
  if (!loaded && startupProblem !== undefined) {
    return (
      <StartupNotice
        problem={startupProblem}
        onRetry={() => client.recover()}
        onUseCapability={(capability) => {
          putCapabilityInHash(capability);
          client.recover();
        }}
      />
    );
  }
  const restartKey = keyHint(config, "restart-session");
  // The Changes tab is the route's `entry=changes`; it needs a task and nothing of a session.
  const changesCurrent = changesView && currentTask !== undefined;
  const settingsBinding = formatBinding(config, "settings");
  // The composer is a view, not a dialog: `prefix t` shows it over the selected task, and it is
  // also what the main area shows when no task or loose terminal is selected (`layout.md`,
  // **New task view**, **Empty states**).
  const showComposer =
    composing !== undefined || (selection.taskId === null && current === undefined);
  const composerProject =
    composing?.project ??
    projects.find((project) => project.id === selection.projectId) ??
    projects[0];
  const composer =
    showComposer && loaded && composerProject !== undefined ? (
      <NewTaskView
        // A project navigation (the sidebar, or a group's "+") is a new composer: without this
        // the view keeps the old project while the sidebar and the URL name the new one.
        key={composerProject.id}
        projects={projects}
        project={composerProject}
        config={config}
        profiles={profiles}
        chatDrivers={chatDrivers}
        capabilitiesReady={capabilitiesReady}
        draft={composerDraft}
        onDraftChange={setComposerDraft}
        loadBranches={loadBranches}
        onCreate={createTask}
        onResolveIssue={resolveIssue}
        opened={composing?.opened ?? 0}
        onCancel={closeNewTask}
      />
    ) : undefined;

  const currentFinishActions =
    currentTask === undefined ? undefined : finishActions.get(currentTask.id);
  const removeTaskFinishActions =
    dialog?.kind === "remove-task" ? finishActions.get(dialog.task.id) : undefined;
  const changesPane =
    changesCurrent && currentTask !== undefined && currentFinishActions !== undefined ? (
      <ChangesView
        key={currentTask.id}
        task={currentTask}
        changes={changes.byTask.get(currentTask.id)}
        failed={changes.failed}
        store={client.changes}
        actions={currentFinishActions}
        pullRequest={pullRequests.byTask.get(currentTask.id)}
        onPullRequest={(request) => pullRequests.remember(request)}
        onSettle={() => void toggleSettle(currentTask)}
      />
    ) : undefined;

  const session =
    current?.terminal !== undefined &&
    (current.type === "terminal" || currentSession?.view === "terminal") ? (
      <TerminalView
        key={current.terminal.id}
        client={client}
        terminal={current.terminal}
        onFit={rememberFitSize}
        exitHint={
          currentSession
            ? `${describeSessionState(currentSession).note ?? ""} ${
                restartKey ? `Press ${restartKey}.` : ""
              }`.trim()
            : undefined
        }
      />
    ) : currentSession?.view === "chat" &&
      currentSession.kind !== "shell" &&
      chat !== undefined &&
      chatFiles !== undefined ? (
      <ChatView
        key={currentSession.id}
        store={chat.store}
        draft={chatDrafts.get(currentSession.id) ?? ""}
        onDraftChange={(update) => {
          const id = currentSession.id;
          setChatDrafts((previous) => {
            const value = previous.get(id) ?? "";
            const next = typeof update === "function" ? update(value) : update;
            if (next === value) return previous;
            const drafts = new Map(previous);
            if (next === "") drafts.delete(id);
            else drafts.set(id, next);
            return drafts;
          });
        }}
        files={chatFiles}
        agent={currentSession.kind}
        followUp={chatDriver?.followUp}
        modelPickerAnchor={modelPickerAnchor}
        reasoningPickerAnchor={reasoningPickerAnchor}
        canChooseAgent={Object.values(config.agents).some((agent) => agent.enabled.value)}
        abortHint={keyHint(config, "abort-turn")}
        aborting={chat.aborting}
        onSend={chat.send}
        onAbort={chat.abort}
        onRespond={chat.respond}
        onChangeModel={() => invoke("change-model")}
        onChangeReasoning={() => invoke("change-reasoning")}
      />
    ) : currentSession && currentSession.state !== "running" ? (
      <StoppedSession
        key={currentSession.id}
        session={currentSession}
        taskState={currentTask?.state}
        restartHint={restartKey}
        onRestart={() => void restartSession(currentSession)}
      />
    ) : undefined;

  return (
    <AppShell sidebarWidth={sidebar.hidden ? 0 : sidebar.width}>
      {!sidebar.hidden && (
        <SidebarPanel>
          <Sidebar
            tree={tree}
            onToggleSidebar={sidebar.toggle}
            onToggleGrouping={actions["sidebar-mode"].run}
            selection={selection}
            composing={composing}
            flat={flatSidebar}
            config={config}
            changes={changes.byTask}
            pullRequests={pullRequests.byTask}
            onSelectTask={showTask}
            onSelectLoose={() => choose({ taskId: null, entryId: undefined })}
            onSelectTerminal={selectEntry}
            onRenameTerminal={openRenameEntry}
            onRestartTerminal={(entry) => void restartLooseTerminal(entry)}
            onCloseTerminal={(id) => void closeTerminal(id)}
            onRenameTask={openRenameTask}
            onToggleSettle={(task) => void toggleSettle(task)}
            onRemoveTask={openRemoveTask}
            onRemoveProject={openRemoveProject}
            onViewSource={openTaskSource}
            onNewTask={(project) =>
              project === undefined ? invoke("new-task") : openNewTask(project)
            }
            newTaskEnabled={actions["new-task"].enabled}
            onFindTask={openFindTask}
            onLeaveList={leaveSidebarList}
            onReturnToWorkspace={returnToWorkspace}
          />
          <SidebarResizeHandle
            width={sidebar.width}
            maxWidth={sidebar.maxWidth}
            onResize={sidebar.setWidth}
            onReset={sidebar.resetWidth}
          />
          <ShellStatus
            placement="footer"
            connection={connection}
            armed={armed}
            prefix={prefix}
            failure={failure}
            onDismissFailure={dismissFailure}
            onOpenConnection={openConnectionRecovery}
            onOpenConfigProblems={openConfigProblems}
            actions={
              <>
                <IconButton
                  label="Settings"
                  tooltip={`Settings · ${settingsBinding}`}
                  icon="settings"
                  size="icon-sm"
                  onClick={(event) => openSettings(event.currentTarget)}
                />
                <IconButton
                  id={ADD_PROJECT_BUTTON_ID}
                  label="Add project"
                  tooltip={formatBinding(config, "add-project")}
                  icon="add-project"
                  size="icon-sm"
                  onClick={() => actions["add-project"].run()}
                />
              </>
            }
          />
        </SidebarPanel>
      )}
      <MainPanel className="flex min-h-0 flex-col bg-background">
        {/* One placement at a time: the footer owns the facts while the pane is shown, so the
            hidden state gets the strip and none of the live regions is announced twice. */}
        {sidebar.hidden && (
          <ShellStatus
            placement="strip"
            connection={connection}
            armed={armed}
            prefix={prefix}
            failure={failure}
            onDismissFailure={dismissFailure}
            onOpenConnection={openConnectionRecovery}
            onOpenConfigProblems={openConfigProblems}
          />
        )}
        {(currentTaskNode || (showComposer && loaded && composerProject !== undefined)) && (
          <TaskHeader
            key={showComposer ? "draft" : currentTaskNode?.task.id}
            node={showComposer ? undefined : currentTaskNode}
            onShowSidebar={sidebar.hidden ? sidebar.toggle : undefined}
            project={showComposer ? composerProject : currentTaskProject}
            changes={
              showComposer || !currentTaskNode
                ? undefined
                : changes.byTask.get(currentTaskNode.task.id)
            }
            pullRequest={
              showComposer || !currentTaskNode
                ? undefined
                : pullRequests.byTask.get(currentTaskNode.task.id)
            }
            config={config}
            onSettle={(task) => void toggleSettle(task)}
            onRename={openRenameTask}
            onRemove={openRemoveTask}
            onViewSource={openTaskSource}
          />
        )}
        {(currentTaskNode || (showComposer && loaded && composerProject !== undefined)) && (
          <SessionTabs
            entries={showComposer ? [] : (currentTaskNode?.sessions ?? [])}
            draftLabel={showComposer ? "New task" : undefined}
            agentPickerAnchor={agentPickerAnchor}
            position={appearance.tabPosition}
            view={
              currentSession === undefined || showComposer
                ? undefined
                : {
                    value: currentSession.view,
                    reason: actions["switch-view"].enabled
                      ? undefined
                      : actions["switch-view"].reason,
                    onSwitch: () => invoke("switch-view"),
                  }
            }
            labels={currentSessionLabels}
            currentId={showComposer ? undefined : selection.entryId}
            changes={
              showComposer
                ? undefined
                : {
                    current: changesCurrent,
                    onSelect: () => invoke("changes"),
                    hint: keyHint(config, "changes"),
                  }
            }
            config={config}
            onSelect={selectEntry}
            onStop={(each) =>
              each.id === currentSession?.id ? invoke("stop-session") : void stopSession(each)
            }
            onRestart={(each) =>
              each.id === currentSession?.id ? invoke("restart-session") : void restartSession(each)
            }
            onRemove={(each) =>
              each.id === currentSession?.id ? invoke("remove-session") : openRemoveSession(each)
            }
            onRename={openRenameEntry}
            onNewShell={() => invoke("new-terminal")}
            onNewAgent={() => invoke("new-agent")}
          />
        )}
        {sidebar.hidden && !currentTaskNode && composerProject === undefined && (
          <div className="px-2 py-1">
            <IconButton label="Show sidebar" icon="show-sidebar" onClick={sidebar.toggle} />
          </div>
        )}
        <TaskContent>
          {handoff !== undefined ? (
            <HandOffNotice target={handoff.target} live={handoff.live} />
          ) : watchFailure !== undefined ? (
            <WatchFailureState failure={watchFailure} onRetry={retryWatches} />
          ) : !loaded ? (
            <WorkspaceLoading />
          ) : (
            (composer ??
            changesPane ??
            session ?? (
              <EmptyWorkspace
                hasProjects={projects.length > 0}
                task={currentTask}
                terminalHint={pressHint(config, "new-terminal")}
                agentHint={pressHint(config, "new-agent")}
                onAddProject={addProject}
                onNewTerminal={() => invoke("new-terminal")}
                onNewAgent={() => invoke("new-agent")}
              />
            ))
          )}
        </TaskContent>
      </MainPanel>
      {dialog?.kind === "add-project" && (
        <AddProjectDialog
          onAdd={addProject}
          onBrowse={browse}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "pick-agent" && (
        <AgentPicker
          context={{ taskId: dialog.taskId }}
          profiles={profiles}
          agents={config.agents}
          settings={taskSettingsFor(config, currentTaskProject?.path ?? "")}
          chatDrivers={chatDrivers}
          capabilitiesReady={capabilitiesReady}
          anchor={agentPickerAnchor}
          onStart={(choice) => startAgent(dialog.taskId, choice)}
          onClose={() => setDialog(undefined)}
        />
      )}
      {(dialog?.kind === "chat-model" || dialog?.kind === "chat-reasoning") &&
        canShowChatPicker &&
        chatPicker !== undefined && (
          <ChatChoiceDialog
            context={{ taskId: chatPicker.session.taskId }}
            store={chatPicker.chat.store}
            agent={chatPicker.session.kind}
            launch={chatPicker.session.launch}
            profiles={profiles}
            agents={config.agents}
            settings={taskSettingsFor(config, currentTaskProject?.path ?? "")}
            chatDrivers={chatDrivers}
            anchor={dialog.kind === "chat-model" ? modelPickerAnchor : reasoningPickerAnchor}
            onStart={(choice) => startAgent(chatPicker.session.taskId, choice)}
            kind={dialog.kind === "chat-model" ? "model" : "reasoning"}
            onSetModel={chatPicker.chat.setModel}
            onSetReasoning={chatPicker.chat.setReasoning}
            onClose={() => setDialog(undefined)}
          />
        )}
      {dialog?.kind === "switch-view" && (
        <SwitchViewDialog
          session={dialog.session}
          target={dialog.target}
          working={dialog.working}
          waiting={dialog.waiting}
          onSwitch={async () => {
            await switchView(dialog.session, dialog.target);
            setDialog(undefined);
          }}
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
      {dialog?.kind === "rename" && (
        <RenameDialog
          target={dialog.target}
          onSave={(name) => renameEntry(dialog.target, name)}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "remove-task" && (
        <RemoveTaskDialog
          task={dialog.task}
          workspaceMissing={dialog.workspaceMissing === true}
          loadLiveBranch={
            removeTaskFinishActions === undefined
              ? undefined
              : () => removeTaskFinishActions.finish().then((finish) => finish.branch)
          }
          onRemove={(force) => removeTask(dialog.task, force)}
          onClose={closeRemoveTask}
        />
      )}
      {dialog?.kind === "remove-project" && (
        <RemoveProjectDialog
          project={dialog.project}
          // Read live, so a task created or settled while the dialog is open is still counted.
          taskCount={tasks.filter((task) => task.projectId === dialog.project.id).length}
          onRemove={() => removeProject(dialog.project)}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "task-source" && dialog.task.source !== undefined && (
        <TaskSourceDialog
          source={dialog.task.source}
          taskTitle={dialog.task.title}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "find-task" && (
        <FindTaskDialog
          projects={projects}
          tasks={tasks}
          onOpen={openTask}
          onContinue={continueTask}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "command-palette" && (
        <CommandPaletteDialog
          actions={actions}
          onRun={(action) => {
            setDialog(undefined);
            invoke(action);
          }}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "config-problems" && (
        <ConfigProblemsDialog onClose={() => setDialog(undefined)} />
      )}
      {dialog?.kind === "connection" && (
        <ConnectionRecoveryDialog onClose={() => setDialog(undefined)} />
      )}
    </AppShell>
  );
}

/**
 * What the task content shows while a session switches views. A `handoff-only` driver's two
 * frontends never overlap, so between the stop and the start there is no pane to show. A
 * `both-live` driver starts a second client of the agent's server beside the live one, so the
 * agent keeps working and nothing is lost. The tab strip keeps the session, its name and its place
 * throughout.
 */
function HandOffNotice({ target, live }: { target: SessionView; live: boolean }) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-1 px-4"
      role="status"
      aria-label={live ? `Opening the ${target} view` : `Switching this session to ${target}`}
      aria-live="polite"
    >
      <p className="m-0 text-muted-foreground">
        {live ? `Opening the ${target} view…` : `Switching this session to ${target}…`}
      </p>
      <p className="m-0 text-xs text-muted-foreground">
        {live
          ? "The agent keeps running in both views."
          : "The agent keeps its conversation; the frontend starts again."}
      </p>
    </div>
  );
}

/** The main area's wait: no list is a workspace until every watch has delivered once. */
function WorkspaceLoading() {
  return (
    <div
      className="flex h-full items-center justify-center px-4"
      role="status"
      aria-label="Loading the workspace"
    >
      <p className="m-0 text-sm text-muted-foreground">Loading the workspace…</p>
    </div>
  );
}

/**
 * A connected server refused one of the list watches. One muted line names the list, as the
 * file-link notice does, and Retry watches it again; the first-run form must never stand in for
 * a workspace we could not read.
 */
function WatchFailureState({ failure, onRetry }: { failure: WatchFailure; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4">
      <p className="m-0 text-sm text-muted-foreground" role="note">
        The server refused the {failure.label}.
      </p>
      <Button variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/**
 * The main area's remaining empty states (`layout.md`, **Empty states**): no project at all, or a
 * task without sessions. A task that is merely not selected shows the new-task composer instead.
 */
function EmptyWorkspace({
  hasProjects,
  task,
  terminalHint,
  agentHint,
  onAddProject,
  onNewTerminal,
  onNewAgent,
}: {
  hasProjects: boolean;
  task: { id: string; title: string; state: "active" | "settled" } | undefined;
  terminalHint: string | undefined;
  agentHint: string | undefined;
  onAddProject: (path: string) => Promise<void>;
  onNewTerminal: () => void;
  onNewAgent: (opener?: HTMLElement) => void;
}) {
  if (!hasProjects) return <NoProjectState onAdd={onAddProject} />;
  if (task === undefined) return null;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-4">
      <p className="m-0 text-muted-foreground">No sessions</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button
          variant="default"
          disabled={task.state === "settled"}
          onClick={(event) => onNewAgent(event.currentTarget)}
        >
          Start agent
        </Button>
        <Button variant="outline" disabled={task.state === "settled"} onClick={onNewTerminal}>
          Open shell
        </Button>
      </div>
      {task.state === "settled" && (
        <p className="m-0 text-sm text-muted-foreground" role="note">
          {SETTLED_TASK_MESSAGE}
        </p>
      )}
      {task.state !== "settled" && (
        <p className="m-0 text-xs text-muted-foreground">
          {[agentHint, terminalHint].filter(Boolean).join(" ")}
        </p>
      )}
    </div>
  );
}

/** "Add a repository to start": the path field is inline, not a dialog (`layout.md`). */
function NoProjectState({ onAdd }: { onAdd: (path: string) => Promise<void> }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (path.trim() === "") return;
    setError(undefined);
    setBusy(true);
    try {
      await onAdd(path);
      setPath("");
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="mx-auto flex h-full w-full max-w-lg flex-col items-center justify-center gap-3 px-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 className="m-0 text-base font-semibold">Add a repository to start</h2>
      <div className="flex w-full items-center gap-2">
        <Input
          aria-label="Repository path"
          placeholder="/path/to/repository"
          value={path}
          disabled={busy}
          onChange={(event) => setPath(event.target.value)}
        />
        <Button type="submit" variant="default" disabled={busy || path.trim() === ""}>
          Add
        </Button>
      </div>
      {error && (
        <p className="m-0 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <p className="m-0 text-center text-xs text-muted-foreground">
        Defaults such as the worktree root live in config.toml.
      </p>
    </form>
  );
}
