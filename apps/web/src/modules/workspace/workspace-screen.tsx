import { describeSessionState } from "@corral/client/session-state";
import { describeError } from "@corral/client/rpc-errors";
import { ActionId, type ClientConfig } from "@corral/protocol/config";
import { useState } from "react";
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
} from "../../common/ui/index.ts";
import { AddProjectDialog } from "../projects/index.ts";
import { AgentPicker, RemoveSessionDialog, StoppedSession } from "../sessions/index.ts";
import { NewTaskView, RemoveTaskDialog, TaskSourceDialog } from "../tasks/index.ts";
import { TerminalView } from "../terminal/index.ts";
import { ConnectionNotice } from "../connection/index.ts";
import {
  CommandPaletteDialog,
  ConfigProblemsDialog,
  ConfigProblemsNotice,
  formatBinding,
} from "../keymap/index.ts";
import { SETTINGS_BUTTON_ID, useRestoreSettingsFocus } from "../settings/index.ts";
import { FindTaskDialog } from "./find-task-dialog.tsx";
import { RenameDialog } from "./rename-dialog.tsx";
import { SessionTabs } from "./session-tabs.tsx";
import { Sidebar } from "./sidebar.tsx";
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
  search,
  onChange,
  onOpenBoard,
  onOpenSettings,
}: WorkspaceScreenProps) {
  useRestoreSettingsFocus();
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
    current,
    currentSession,
    currentTask,
    currentTaskNode,
    currentTaskProject,
    currentSessionLabels,
    sidebar,
    dialog,
    composing,
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
    openRenameTask,
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
    addProject,
    createTask,
    resolveIssue,
    removeTask,
    setDialog,
  } = useWorkspace({ search, onChange, onOpenBoard, onOpenSettings });
  const restartKey = keyHint(config, "restart-session");
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
        projects={projects}
        project={composerProject}
        config={config}
        profiles={profiles}
        loadBranches={loadBranches}
        onCreate={createTask}
        onResolveIssue={resolveIssue}
        onCancel={closeNewTask}
      />
    ) : undefined;

  const session =
    current?.terminal !== undefined ? (
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
            selection={selection}
            flat={flatSidebar}
            config={config}
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
              <ConnectionNotice state={connection} />
              <span
                className="ml-auto flex items-center gap-1 text-xs text-muted-foreground"
                role={armed ? "status" : undefined}
                aria-label={armed ? "prefix mode" : undefined}
              >
                {armed ? <Badge variant="secondary">prefix…</Badge> : <Kbd>{prefix}</Kbd>}
              </span>
              <ConfigProblemsNotice onOpen={openConfigProblems} />
              <IconButton
                id={SETTINGS_BUTTON_ID}
                label="Settings"
                tooltip={`Settings · ${settingsBinding}`}
                icon="settings"
                onClick={(event) => openSettings(event.currentTarget)}
              />
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
        {currentTaskNode && composing === undefined && (
          <TaskHeader
            node={currentTaskNode}
            project={currentTaskProject}
            config={config}
            onSettle={(task) => void toggleSettle(task)}
            onRename={openRenameTask}
            onRemove={openRemoveTask}
            onViewSource={openTaskSource}
          />
        )}
        {currentTaskNode && composing === undefined && (
          <SessionTabs
            entries={currentTaskNode.sessions}
            labels={currentSessionLabels}
            currentId={selection.entryId}
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
        <div className="relative min-h-0 flex-1" role="region" aria-label="task content">
          {composer ??
            session ??
            (loaded && (
              <EmptyWorkspace
                hasProjects={projects.length > 0}
                task={currentTask}
                terminalHint={pressHint(config, "new-terminal")}
                agentHint={pressHint(config, "new-agent")}
                onAddProject={addProject}
                onNewTerminal={() => void createTerminal(selection.taskId)}
                onNewAgent={openAgentPicker}
              />
            ))}
        </div>
      </MainPanel>
      {dialog?.kind === "add-project" && (
        <AddProjectDialog onAdd={addProject} onClose={() => setDialog(undefined)} />
      )}
      {dialog?.kind === "pick-agent" && (
        <AgentPicker
          profiles={profiles}
          onStart={(choice) => startAgent(dialog.taskId, choice)}
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
    </AppShell>
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
      <h2 className="m-0 text-base font-medium">Add a repository to start</h2>
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
