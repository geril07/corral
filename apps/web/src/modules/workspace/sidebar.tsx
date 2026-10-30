import { cn } from "../../common/lib/cn.ts";
import { sessionStatus, taskStatus } from "@corral/client/agent-status";
import { sessionLabels } from "@corral/client/session-labels";
import { describeSessionState } from "@corral/client/session-state";
import type {
  Entry,
  SessionEntry,
  Selection,
  TaskNode,
  TerminalEntry,
  WorkspaceTree,
} from "@corral/client/workspace-tree";
import type { Project, Session, Task, TerminalInfo } from "@corral/protocol/rpc";
import { useState } from "react";
import { Badge, Button, Tooltip, TreeIndent, TreeRow } from "../../common/ui/index.ts";
import { StatusIndicator } from "../status/index.ts";

export function terminalLabel(terminal: TerminalInfo): string {
  const program = terminal.command.split("/").pop() || terminal.command;
  const folder = terminal.cwd.replace(/\/+$/, "").split("/").pop() || "/";
  return `${program} · ${folder}`;
}

// Rows read from the left and cut at the right: a centred, clipped label hides the start of a title.
const ROW_BUTTON =
  "min-w-0 flex-1 shrink justify-start overflow-hidden px-2.5 py-1.5 text-left text-inherit";
const ROW_ICON = "my-0.5";
const SETTLE_TOGGLE =
  "w-full px-2.5 py-1 text-left text-text-muted disabled:cursor-default disabled:opacity-60";

interface SidebarProps {
  tree: WorkspaceTree;
  selection: Selection;
  onSelectProject: (project: Project) => void;
  onSelectTask: (task: Task) => void;
  onSelectLoose: () => void;
  onSelectEntry: (entry: Entry) => void;
  onCloseTerminal: (id: string) => void;
  onStopSession: (session: Session) => void;
  onRestartSession: (session: Session) => void;
  onRemoveSession: (session: Session) => void;
  onToggleSettle: (task: Task) => void;
  onRemoveTask: (task: Task) => void;
  onAddProject: () => void;
  onNewTask: () => void;
  onNewTerminal: () => void;
  onNewAgent: () => void;
}

export function Sidebar(props: SidebarProps) {
  const { tree, selection } = props;
  // Projects whose settled tasks the user opened; the group is also open while it holds the current task.
  const [openSettledGroups, setOpenSettledGroups] = useState<ReadonlySet<string>>(new Set());
  const toggleSettle = (projectId: string) =>
    setOpenSettledGroups((open) => {
      const next = new Set(open);
      if (!next.delete(projectId)) next.add(projectId);
      return next;
    });

  const terminalItem = ({ terminal }: TerminalEntry) => (
    <li key={terminal.id}>
      <TreeRow current={terminal.id === selection.entryId}>
        <Button
          variant="ghost"
          className={ROW_BUTTON}
          aria-current={terminal.id === selection.entryId ? "true" : undefined}
          onClick={() => props.onSelectEntry({ type: "terminal", id: terminal.id, terminal })}
        >
          <span className={terminal.exit ? "text-text-muted" : undefined}>
            {terminalLabel(terminal)}
          </span>
          {terminal.exit && (
            <Badge className="ml-1 text-text-muted">exited ({terminal.exit.exitCode})</Badge>
          )}
        </Button>
        <Button
          variant="ghost-danger"
          size="icon-sm"
          className={ROW_ICON}
          aria-label={`close ${terminalLabel(terminal)}`}
          onClick={() => props.onCloseTerminal(terminal.id)}
        >
          ×
        </Button>
      </TreeRow>
    </li>
  );

  const taskItem = ({ task, sessions }: TaskNode) => {
    const status = taskStatus(sessions.map((entry) => entry.session))?.status;
    const labels = sessionLabels(sessions.map((entry) => entry.session));
    return (
      <li key={task.id}>
        <TreeRow current={task.id === selection.taskId}>
          <StatusIndicator status={status} />
          <Tooltip content={task.title}>
            <Button
              variant="ghost"
              className={ROW_BUTTON}
              aria-current={task.id === selection.taskId ? "true" : undefined}
              title={status?.message}
              onClick={() => props.onSelectTask(task)}
            >
              <span className={cn("truncate", task.state === "settled" && "text-text-muted")}>
                {task.title}
              </span>
              <span className="min-w-0 max-w-1/3 truncate text-text-muted">{task.branch}</span>
            </Button>
          </Tooltip>
          <Button
            variant="ghost-muted"
            size="icon-sm"
            className={ROW_ICON}
            aria-label={`${task.state === "active" ? "settle" : "unsettle"} ${task.title}`}
            onClick={() => props.onToggleSettle(task)}
          >
            {task.state === "active" ? "▾" : "▴"}
          </Button>
          <Button
            variant="ghost-danger"
            size="icon-sm"
            className={ROW_ICON}
            aria-label={`remove task ${task.title}`}
            onClick={() => props.onRemoveTask(task)}
          >
            ×
          </Button>
        </TreeRow>
        {sessions.length > 0 && (
          <TreeIndent>
            <ul>{sessions.map((entry) => sessionItem(entry, labels.get(entry.session.id)))}</ul>
          </TreeIndent>
        )}
      </li>
    );
  };

  const sessionItem = (entry: SessionEntry, label: string | undefined) => {
    const { session } = entry;
    const current = session.id === selection.entryId;
    const running = session.state === "running";
    const { badge, note } = describeSessionState(session);
    const status = sessionStatus(session);
    return (
      <li key={session.id}>
        <TreeRow current={current}>
          <StatusIndicator status={status} />
          <Button
            variant="ghost"
            className={ROW_BUTTON}
            aria-current={current ? "true" : undefined}
            title={[status?.message, note].filter(Boolean).join("\n") || undefined}
            onClick={() => props.onSelectEntry(entry)}
            onKeyDown={(event) => {
              // Enter on the selected session that is not running starts it again.
              if (event.key !== "Enter" || !current || running) return;
              event.preventDefault();
              props.onRestartSession(session);
            }}
          >
            <span className={running ? undefined : "text-text-muted"}>{label ?? session.kind}</span>
            {badge && <span className="text-text-muted"> {badge}</span>}
          </Button>
          {running ? (
            <Button
              variant="ghost-muted"
              size="icon-sm"
              className={ROW_ICON}
              aria-label={`stop ${label ?? session.kind}`}
              onClick={() => props.onStopSession(session)}
            >
              ■
            </Button>
          ) : (
            <Button
              variant="ghost-muted"
              size="icon-sm"
              className={ROW_ICON}
              aria-label={`restart ${label ?? session.kind}`}
              onClick={() => props.onRestartSession(session)}
            >
              ▶
            </Button>
          )}
          <Button
            variant="ghost-danger"
            size="icon-sm"
            className={ROW_ICON}
            aria-label={`remove ${label ?? session.kind}`}
            onClick={() => props.onRemoveSession(session)}
          >
            ×
          </Button>
        </TreeRow>
      </li>
    );
  };

  return (
    <nav
      className="flex min-h-0 flex-1 flex-col justify-between"
      aria-label="workspace"
      // Clicking must not take keyboard focus away from the terminal.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul className="m-0 list-none p-0">
          {tree.projects.map(({ project, active, settled }) => {
            const holdsCurrent = settled.some(({ task }) => task.id === selection.taskId);
            const settledOpen = holdsCurrent || openSettledGroups.has(project.id);
            return (
              <li key={project.id}>
                <TreeRow project current={project.id === selection.projectId}>
                  <Button
                    variant="ghost"
                    className={`${ROW_BUTTON} font-semibold`}
                    onClick={() => props.onSelectProject(project)}
                  >
                    <span
                      className={project.id === selection.projectId ? "text-accent" : undefined}
                    >
                      {project.name}
                    </span>
                  </Button>
                </TreeRow>
                <TreeIndent>
                  <ul>
                    {active.map(taskItem)}
                    {settled.length > 0 && (
                      <li>
                        <Button
                          variant="ghost"
                          className={SETTLE_TOGGLE}
                          aria-expanded={settledOpen}
                          disabled={holdsCurrent}
                          onClick={() => toggleSettle(project.id)}
                        >
                          <span aria-hidden>{settledOpen ? "▾" : "▸"} </span>
                          Settled ({settled.length})
                        </Button>
                        {settledOpen && <ul>{settled.map(taskItem)}</ul>}
                      </li>
                    )}
                  </ul>
                </TreeIndent>
              </li>
            );
          })}
          {tree.loose.length > 0 && (
            <li>
              <TreeRow project current={selection.taskId === null}>
                <Button
                  variant="ghost"
                  className={`${ROW_BUTTON} font-semibold`}
                  onClick={props.onSelectLoose}
                >
                  No task
                </Button>
              </TreeRow>
              <TreeIndent>
                <ul>{tree.loose.map(terminalItem)}</ul>
              </TreeIndent>
            </li>
          )}
        </ul>
      </div>
      <div className="mt-auto flex flex-wrap border-t border-border">
        <Button variant="ghost" size="sm" onClick={props.onAddProject}>
          Add project
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={props.onNewTask}
          disabled={selection.projectId === undefined}
        >
          New task
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onNewTerminal}>
          New terminal
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={props.onNewAgent}
          disabled={selection.taskId === null}
        >
          New agent
        </Button>
      </div>
    </nav>
  );
}
