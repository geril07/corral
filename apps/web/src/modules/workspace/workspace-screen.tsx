import { describeSessionState } from "@corral/client/session-state";
import { AppShell, MainPanel, SidebarPanel } from "../../common/ui/index.ts";
import { AddProjectDialog } from "../projects/index.ts";
import { AgentPicker, RemoveSessionDialog, StoppedSession } from "../sessions/index.ts";
import { NewTaskDialog, RemoveTaskDialog } from "../tasks/index.ts";
import { TerminalView } from "../terminal/index.ts";
import { ConnectionNotice } from "../connection/index.ts";
import { Sidebar } from "./sidebar.tsx";
import { useWorkspace } from "./use-workspace.ts";
import type { WorkspaceSearch } from "./workspace-search.ts";

export interface WorkspaceScreenProps {
  search: WorkspaceSearch;
  onChange: (search: WorkspaceSearch) => void;
  onOpenBoard: (search: WorkspaceSearch) => void;
}

export function WorkspaceScreen({ search, onChange, onOpenBoard }: WorkspaceScreenProps) {
  const {
    client,
    prefix,
    connection,
    tree,
    selection,
    loaded,
    current,
    currentSession,
    dialog,
    failure,
    armed,
    rememberFitSize,
    choose,
    showTask,
    createTerminal,
    openAgentPicker,
    pickAgent,
    closeTerminal,
    stopSession,
    restartSession,
    removeSession,
    selectEntry,
    toggleSettle,
    openNewTask,
    openRemoveTask,
    addProject,
    createTask,
    removeTask,
    setDialog,
  } = useWorkspace({ search, onChange, onOpenBoard });

  return (
    <AppShell>
      <SidebarPanel>
        <Sidebar
          tree={tree}
          selection={selection}
          onSelectProject={(project) =>
            choose({ projectId: project.id, taskId: undefined, entryId: undefined })
          }
          onSelectTask={showTask}
          onSelectLoose={() => choose({ taskId: null, entryId: undefined })}
          onSelectEntry={selectEntry}
          onCloseTerminal={(id) => void closeTerminal(id)}
          onStopSession={(session) => void stopSession(session)}
          onRestartSession={(session) => void restartSession(session)}
          onRemoveSession={(session) => setDialog({ kind: "remove-session", session })}
          onToggleSettle={(task) => void toggleSettle(task)}
          onRemoveTask={openRemoveTask}
          onAddProject={() => setDialog({ kind: "add-project" })}
          onNewTask={openNewTask}
          onNewTerminal={() => void createTerminal(selection.taskId)}
          onNewAgent={openAgentPicker}
        />
        <footer className="border-t border-border px-2.5 py-2 text-text-muted">
          <ConnectionNotice state={connection} />
          {failure && (
            <p className="my-0.5 text-danger" role="alert">
              {failure}
            </p>
          )}
          {armed ? (
            <output className="my-0.5 block text-accent" aria-label="prefix mode">
              prefix: c shell · s agent · x stop · r restart · X remove session · n/p session · t
              new task · T remove task · d settle · j/k task · P add project · b board · g blocked
            </output>
          ) : (
            <p className="my-0.5">{prefix} then c s x r X n p t T d j k P b g</p>
          )}
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
                ? `${describeSessionState(currentSession).note ?? ""} Press ${prefix}, then r.`
                : undefined
            }
          />
        ) : currentSession && currentSession.state !== "running" ? (
          <StoppedSession
            key={currentSession.id}
            session={currentSession}
            prefix={prefix}
            onRestart={() => void restartSession(currentSession)}
          />
        ) : (
          loaded &&
          !currentSession && (
            <p className="p-4 text-text-muted">
              {selection.taskId === null
                ? `No terminals. Press ${prefix}, then c.`
                : `No sessions in this task. Press ${prefix}, then c for a shell or s for an agent.`}
            </p>
          )
        )}
      </MainPanel>
      {dialog?.kind === "add-project" && (
        <AddProjectDialog onAdd={addProject} onClose={() => setDialog(undefined)} />
      )}
      {dialog?.kind === "new-task" && (
        <NewTaskDialog
          project={dialog.project}
          branches={dialog.branches}
          onCreate={createTask}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "pick-agent" && (
        <AgentPicker
          onPick={(kind) => pickAgent(dialog.taskId, kind)}
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
      {dialog?.kind === "remove-task" && (
        <RemoveTaskDialog
          task={dialog.task}
          onRemove={(force) => removeTask(dialog.task, force)}
          onClose={() => setDialog(undefined)}
        />
      )}
    </AppShell>
  );
}
