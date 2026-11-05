import { describeSessionState } from "@corral/client/session-state";
import { describeError } from "@corral/client/rpc-errors";
import type { WatchFailure } from "@corral/client/watch-store";
import { ActionId, taskSettingsFor, type ClientConfig } from "@corral/protocol/config";
import type { SessionView } from "@corral/protocol/rpc";
import { useRef, useState } from "react";
import {
  Alert,
  AlertDescription,
  AppShell,
  Badge,
  Button,
  IconButton,
  Input,
  Kbd,
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
import { NewTaskView, RemoveTaskDialog, TaskSourceDialog } from "../tasks/index.ts";
import { TerminalView } from "../terminal/index.ts";
import {
  ConnectionNotice,
  ConnectionRecoveryDialog,
  putCapabilityInHash,
  StartupNotice,
  type NoticeProblem,
} from "../connection/index.ts";
import {
  CommandPaletteDialog,
  ConfigProblemsDialog,
  ConfigProblemsNotice,
  formatBinding,
} from "../keymap/index.ts";
import { SETTINGS_BUTTON_ID, useAppearance, useSettingsActivity } from "../settings/index.ts";
import { FindTaskDialog } from "./find-task-dialog.tsx";
import { RenameDialog } from "./rename-dialog.tsx";
import { SessionTabs } from "./session-tabs.tsx";
import { Sidebar } from "./sidebar.tsx";
import { ADD_PROJECT_BUTTON_ID } from "./sidebar-focus.ts";
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
    openChanges,
    renameEntry,
    selectEntry,
    toggleSettle,
    openNewTask,
    closeNewTask,
    loadBranches,
    openRemoveTask,
    openRemoveSession,
    openTaskSource,
    openFindTask,
    openConfigProblems,
    openConnectionRecovery,
    addProject,
    createTask,
    resolveIssue,
    removeTask,
    setDialog,
  } = useWorkspace({
    active: active && !settingsActivity?.open,
    search,
    onChange,
    onOpenBoard,
    onOpenSettings,
  });
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
        modelPickerAnchor={modelPickerAnchor}
        reasoningPickerAnchor={reasoningPickerAnchor}
        canChooseAgent={Object.values(config.agents).some((agent) => agent.enabled.value)}
        abortHint={keyHint(config, "abort-turn")}
        onSend={chat.send}
        onAbort={chat.abort}
        onRespond={chat.respond}
        onChangeModel={() => setDialog({ kind: "chat-model" })}
        onChangeReasoning={() => setDialog({ kind: "chat-reasoning" })}
      />
    ) : currentSession && currentSession.state !== "running" ? (
      <StoppedSession
        key={currentSession.id}
        session={currentSession}
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
            flat={flatSidebar}
            config={config}
            changes={changes.byTask}
            pullRequests={pullRequests.byTask}
            onSelectProject={(project) =>
              choose({ projectId: project.id, taskId: undefined, entryId: undefined })
            }
            onSelectTask={showTask}
            onSelectLoose={() => choose({ taskId: null, entryId: undefined })}
            onSelectTerminal={selectEntry}
            onRenameTerminal={openRenameEntry}
            onCloseTerminal={(id) => void closeTerminal(id)}
            onRenameTask={openRenameTask}
            onToggleSettle={(task) => void toggleSettle(task)}
            onRemoveTask={openRemoveTask}
            onViewSource={openTaskSource}
            onNewTask={openNewTask}
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
          <footer className="shrink-0 border-t border-border">
            {failure && (
              <p
                className="m-0 border-b border-border px-2 py-1 text-xs text-destructive"
                role="alert"
              >
                {failure}
              </p>
            )}
            <div className="flex h-9 items-center gap-1 px-2">
              <IconButton
                id={SETTINGS_BUTTON_ID}
                label="Settings"
                tooltip={`Settings · ${settingsBinding}`}
                icon="settings"
                onClick={(event) => openSettings(event.currentTarget)}
              />
              <IconButton
                id={ADD_PROJECT_BUTTON_ID}
                label="Add project"
                tooltip={formatBinding(config, "add-project")}
                icon="add-project"
                onClick={() => actions["add-project"].run()}
              />
              <ConnectionNotice
                state={connection}
                onOpen={(opener) => openConnectionRecovery(opener)}
              />
              <ConfigProblemsNotice onOpen={openConfigProblems} />
              <span
                className="ml-auto flex items-center gap-1 text-xs text-muted-foreground"
                role={armed ? "status" : undefined}
                aria-label={armed ? "prefix mode" : undefined}
              >
                {armed ? <Badge variant="secondary">prefix…</Badge> : <Kbd>{prefix}</Kbd>}
              </span>
            </div>
          </footer>
        </SidebarPanel>
      )}
      <MainPanel className="flex min-h-0 flex-col bg-background">
        {/* The footer carries the alert with the sidebar; a hidden sidebar must not hide it. */}
        {sidebar.hidden && failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        {(currentTaskNode || (showComposer && loaded && composerProject !== undefined)) && (
          <TaskHeader
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
                    onSwitch: actions["switch-view"].run,
                  }
            }
            labels={currentSessionLabels}
            currentId={showComposer ? undefined : selection.entryId}
            changes={
              showComposer
                ? undefined
                : {
                    current: changesCurrent,
                    onSelect: openChanges,
                    hint: keyHint(config, "changes"),
                  }
            }
            config={config}
            onSelect={selectEntry}
            onStop={(each) => void stopSession(each)}
            onRestart={(each) => void restartSession(each)}
            onRemove={openRemoveSession}
            onRename={openRenameEntry}
            onNewShell={() => void createTerminal(selection.taskId)}
            onNewAgent={openAgentPicker}
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
                onNewTerminal={() => void createTerminal(selection.taskId)}
                onNewAgent={openAgentPicker}
              />
            ))
          )}
        </TaskContent>
      </MainPanel>
      {dialog?.kind === "add-project" && (
        <AddProjectDialog onAdd={addProject} onClose={() => setDialog(undefined)} />
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
        chat !== undefined &&
        currentSession !== undefined &&
        currentSession.kind !== "shell" && (
          <ChatChoiceDialog
            context={{ taskId: currentSession.taskId }}
            store={chat.store}
            agent={currentSession.kind}
            launch={currentSession.launch}
            profiles={profiles}
            agents={config.agents}
            settings={taskSettingsFor(config, currentTaskProject?.path ?? "")}
            chatDrivers={chatDrivers}
            anchor={dialog.kind === "chat-model" ? modelPickerAnchor : reasoningPickerAnchor}
            onStart={(choice) => startAgent(currentSession.taskId, choice)}
            kind={dialog.kind === "chat-model" ? "model" : "reasoning"}
            onSetModel={chat.setModel}
            onSetReasoning={chat.setReasoning}
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
          onSave={async (name) => {
            await renameEntry(dialog.target, name);
            setDialog(undefined);
          }}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "remove-task" && (
        <RemoveTaskDialog
          task={dialog.task}
          onRemove={(force) => removeTask(dialog.task, force)}
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
            actions[action].run();
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
  task: { id: string; title: string } | undefined;
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
        <Button variant="default" onClick={(event) => onNewAgent(event.currentTarget)}>
          Start agent
        </Button>
        <Button variant="outline" onClick={onNewTerminal}>
          Open shell
        </Button>
      </div>
      <p className="m-0 text-xs text-muted-foreground">
        {[agentHint, terminalHint].filter(Boolean).join(" ")}
      </p>
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
