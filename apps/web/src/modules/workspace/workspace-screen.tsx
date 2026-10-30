import { describeSessionState } from "@corral/client/session-state";
import { ActionId, type ClientConfig } from "@corral/protocol/config";
import { AppShell, MainPanel, SidebarPanel } from "../../common/ui/index.ts";
import { AddProjectDialog } from "../projects/index.ts";
import { AgentPicker, RemoveSessionDialog, StoppedSession } from "../sessions/index.ts";
import { NewTaskDialog, RemoveTaskDialog } from "../tasks/index.ts";
import { TerminalView } from "../terminal/index.ts";
import { ConnectionNotice } from "../connection/index.ts";
import {
  CommandPaletteDialog,
  ConfigProblemsDialog,
  ConfigProblemsNotice,
  formatBinding,
} from "../keymap/index.ts";
import { Sidebar } from "./sidebar.tsx";
import { useWorkspace } from "./use-workspace.ts";
import type { WorkspaceSearch } from "./workspace-search.ts";

function pressHint(config: ClientConfig, action: ActionId): string | undefined {
  return config.keys.bindings[action] === null
    ? undefined
    : `Press ${formatBinding(config, action)}.`;
}

export interface WorkspaceScreenProps {
  search: WorkspaceSearch;
  onChange: (search: WorkspaceSearch) => void;
  onOpenBoard: (search: WorkspaceSearch) => void;
}

export function WorkspaceScreen({ search, onChange, onOpenBoard }: WorkspaceScreenProps) {
  const {
    client,
    config,
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
    actions,
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
  const hints = ActionId.options.flatMap((action) => {
    const binding = config.keys.bindings[action];
    return binding === null ? [] : [{ action, binding, label: actions[action].label }];
  });
  const restartHint = pressHint(config, "restart-session");
  const terminalHint = pressHint(config, "new-terminal");
  const agentHint = pressHint(config, "new-agent");

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
          <ConfigProblemsNotice onOpen={() => setDialog({ kind: "config-problems" })} />
          {failure && (
            <p className="my-0.5 text-danger" role="alert">
              {failure}
            </p>
          )}
          {armed ? (
            <output className="my-0.5 block text-accent" aria-label="prefix mode">
              prefix:{" "}
              {hints.map(({ binding, label }) => `${binding} ${label.toLowerCase()}`).join(" · ")}
            </output>
          ) : (
            <p className="my-0.5" aria-label="key hint">
              {prefix} then {hints.map(({ binding }) => binding).join(" ")}
            </p>
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
                ? `${describeSessionState(currentSession).note ?? ""} ${restartHint ?? ""}`.trim()
                : undefined
            }
          />
        ) : currentSession && currentSession.state !== "running" ? (
          <StoppedSession
            key={currentSession.id}
            session={currentSession}
            restartHint={restartHint}
            onRestart={() => void restartSession(currentSession)}
          />
        ) : (
          loaded &&
          !currentSession && (
            <p className="p-4 text-text-muted">
              {selection.taskId === null
                ? ["No terminals.", terminalHint].filter(Boolean).join(" ")
                : ["No sessions in this task.", terminalHint, agentHint].filter(Boolean).join(" ")}
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
