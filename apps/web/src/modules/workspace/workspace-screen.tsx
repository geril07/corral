import { describeSessionState } from "@corral/client/session-state";
import { ActionId, type ClientConfig } from "@corral/protocol/config";
import { AppShell, Button, Kbd, MainPanel, SidebarPanel, Hint } from "../../common/ui/index.ts";
import { AddProjectDialog } from "../projects/index.ts";
import { AgentPicker, RemoveSessionDialog, StoppedSession } from "../sessions/index.ts";
import { NewTaskDialog, RemoveTaskDialog, TaskSourceDialog } from "../tasks/index.ts";
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
import { Sidebar } from "./sidebar.tsx";
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
    openRenameTask,
    renameEntry,
    selectEntry,
    toggleSettle,
    openNewTask,
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
  } = useWorkspace({ search, onChange, onOpenBoard, onOpenSettings });
  const restartKey = keyHint(config, "restart-session");
  const settingsBinding = formatBinding(config, "settings");
  const terminalHint = pressHint(config, "new-terminal");
  const agentHint = pressHint(config, "new-agent");

  return (
    <AppShell>
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
          onSelectEntry={selectEntry}
          onRenameEntry={openRenameEntry}
          onRenameTask={openRenameTask}
          onCloseTerminal={(id) => void closeTerminal(id)}
          onStopSession={(session) => void stopSession(session)}
          onRestartSession={(session) => void restartSession(session)}
          onRemoveSession={openRemoveSession}
          onViewSource={openTaskSource}
          onToggleSettle={(task) => void toggleSettle(task)}
          onRemoveTask={openRemoveTask}
          onAddProject={openAddProject}
          onNewTask={openNewTask}
          onNewTerminal={() => void createTerminal(selection.taskId)}
          onNewAgent={openAgentPicker}
          onFindTask={openFindTask}
          onOpenPalette={openPalette}
          onOpenBoard={() => actions.board.run()}
        />
        <footer className="border-t border-border">
          {failure && (
            <p className="m-0 border-b border-border px-2.5 py-1 text-destructive" role="alert">
              {failure}
            </p>
          )}
          <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1">
            <ConnectionNotice state={connection} />
            <span
              className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground"
              role={armed ? "status" : undefined}
              aria-label={armed ? "prefix mode" : undefined}
            >
              <span className={armed ? "text-primary" : undefined}>
                {armed ? "prefix armed" : "prefix"}
              </span>
              <Kbd>{prefix}</Kbd>
            </span>
            <ConfigProblemsNotice onOpen={openConfigProblems} />
            <Hint content={`Settings · ${settingsBinding}`}>
              <Button
                id={SETTINGS_BUTTON_ID}
                variant="ghost"
                onClick={(event) => openSettings(event.currentTarget)}
              >
                Settings
              </Button>
            </Hint>
          </div>
        </footer>
      </SidebarPanel>
      <MainPanel>
        {current?.terminal ? (
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
        ) : (
          loaded &&
          !currentSession && (
            <EmptyWorkspace
              hasProjects={projects.length > 0}
              hasTask={selection.taskId !== null}
              terminalHint={terminalHint}
              agentHint={agentHint}
              onAddProject={openAddProject}
              onNewTerminal={() => void createTerminal(selection.taskId)}
              onNewAgent={openAgentPicker}
            />
          )
        )}
      </MainPanel>
      {dialog?.kind === "add-project" && (
        <AddProjectDialog onAdd={addProject} onClose={() => setDialog(undefined)} />
      )}
      {dialog?.kind === "new-task" && (
        <NewTaskDialog
          projects={projects}
          project={dialog.project}
          loadBranches={loadBranches}
          onCreate={createTask}
          onResolveIssue={resolveIssue}
          onClose={() => setDialog(undefined)}
        />
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

function EmptyWorkspace({
  hasProjects,
  hasTask,
  terminalHint,
  agentHint,
  onAddProject,
  onNewTerminal,
  onNewAgent,
}: {
  hasProjects: boolean;
  hasTask: boolean;
  terminalHint: string | undefined;
  agentHint: string | undefined;
  onAddProject: (opener?: HTMLElement) => void;
  onNewTerminal: () => void;
  onNewAgent: (opener?: HTMLElement) => void;
}) {
  if (!hasProjects) {
    return (
      <div className="px-4 py-6">
        <p className="mb-3">No projects yet.</p>
        <Button variant="default" onClick={(event) => onAddProject(event.currentTarget)}>
          Add project
        </Button>
        <p className="mt-3 text-muted-foreground">{terminalHint}</p>
      </div>
    );
  }
  return (
    <div className="px-4 py-6">
      <p className="mb-3">{hasTask ? "No sessions in this task." : "No terminals."}</p>
      <div className="flex gap-2">
        <Button variant="default" onClick={onNewTerminal}>
          New terminal
        </Button>
        {hasTask && (
          <Button variant="outline" onClick={(event) => onNewAgent(event.currentTarget)}>
            New agent
          </Button>
        )}
      </div>
      <p className="mt-3 text-muted-foreground">
        {[terminalHint, hasTask ? agentHint : undefined].filter(Boolean).join(" ")}
      </p>
    </div>
  );
}
