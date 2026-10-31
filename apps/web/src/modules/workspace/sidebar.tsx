import {
  compareStatuses,
  sessionStatus,
  taskStatus,
  type TaskStatus,
} from "@corral/client/agent-status";
import { sessionLabels } from "@corral/client/session-labels";
import { describeSessionState } from "@corral/client/session-state";
import type {
  Entry,
  ProjectNode,
  SessionEntry,
  Selection,
  TaskNode,
  TerminalEntry,
  WorkspaceTree,
} from "@corral/client/workspace-tree";
import type { ActionId, ClientConfig } from "@corral/protocol/config";
import type { Project, Session, Task, TerminalInfo } from "@corral/protocol/rpc";
import { useRef, useState, type ReactNode } from "react";
import { cn } from "../../common/lib/cn.ts";
import {
  Badge,
  Button,
  Icon,
  IconButton,
  DropdownMenuItem,
  OverflowMenu,
  Hint,
  TreeIndent,
  TreeRow,
  useTruncatedText,
} from "../../common/ui/index.ts";
import { formatBinding } from "../keymap/index.ts";
import { compactLaunchLabel, launchLine } from "../sessions/index.ts";
import { StatusIndicator } from "../status/index.ts";

export function terminalLabel(terminal: TerminalInfo): string {
  if (terminal.label) return terminal.label;
  const program = terminal.command.split("/").pop() || terminal.command;
  const folder = terminal.cwd.replace(/\/+$/, "").split("/").pop() || "/";
  return `${program} · ${folder}`;
}

interface SidebarProps {
  tree: WorkspaceTree;
  selection: Selection;
  /** Effective bindings for the tooltips; absent in a bare sidebar test. */
  config?: ClientConfig;
  onSelectProject: (project: Project) => void;
  onSelectTask: (task: Task) => void;
  onSelectLoose: () => void;
  onSelectEntry: (entry: Entry) => void;
  /** The rename dialog's opener; the row offers it in its overflow. */
  onRenameEntry: (entry: Entry) => void;
  onCloseTerminal: (id: string) => void;
  onStopSession: (session: Session) => void;
  onRestartSession: (session: Session) => void;
  onRemoveSession: (session: Session) => void;
  onToggleSettle: (task: Task) => void;
  onRemoveTask: (task: Task) => void;
  onAddProject: (opener?: HTMLElement) => void;
  onNewTask: (opener?: HTMLElement) => void;
  onNewTerminal: () => void;
  onNewAgent: (opener?: HTMLElement) => void;
  onOpenPalette: (opener?: HTMLElement) => void;
  onOpenBoard: () => void;
  /** Opens the controlled source dialog; only tasks with a source offer it. */
  onViewSource?: (task: Task, opener?: HTMLElement) => void;
  onFindTask: (opener?: HTMLElement) => void;
}

export function Sidebar(props: SidebarProps) {
  const { tree, selection, config } = props;
  const [closedProjects, setClosedProjects] = useState<ReadonlySet<string>>(new Set());
  const [openTasks, setOpenTasks] = useState<ReadonlySet<string>>(new Set());

  const hint = (label: string, action: ActionId) =>
    config ? `${label} · ${formatBinding(config, action)}` : label;

  const toggleProject = (projectId: string) =>
    setClosedProjects((closed) => {
      const next = new Set(closed);
      if (!next.delete(projectId)) next.add(projectId);
      return next;
    });
  const openProject = (projectId: string) =>
    setClosedProjects((closed) => {
      if (!closed.has(projectId)) return closed;
      const next = new Set(closed);
      next.delete(projectId);
      return next;
    });
  const toggleTask = (taskId: string) =>
    setOpenTasks((open) => {
      const next = new Set(open);
      if (!next.delete(taskId)) next.add(taskId);
      return next;
    });

  const renderTask = (node: TaskNode) => (
    <TaskRow
      key={node.task.id}
      node={node}
      selection={selection}
      open={node.task.id === selection.taskId || openTasks.has(node.task.id)}
      onToggle={() => toggleTask(node.task.id)}
      onSelect={() => {
        openProject(node.task.projectId);
        setOpenTasks((open) => new Set(open).add(node.task.id));
        props.onSelectTask(node.task);
      }}
      onToggleSettle={() => props.onToggleSettle(node.task)}
      onRemove={() => props.onRemoveTask(node.task)}
      onSelectEntry={props.onSelectEntry}
      onStop={props.onStopSession}
      onRestart={props.onRestartSession}
      onRemoveSession={props.onRemoveSession}
      onRenameEntry={props.onRenameEntry}
      onViewSource={
        node.task.source && props.onViewSource
          ? (opener) => props.onViewSource?.(node.task, opener)
          : undefined
      }
      hint={hint}
    />
  );

  return (
    <nav
      className="flex min-h-0 flex-1 flex-col"
      aria-label="workspace"
      // Clicking must not take keyboard focus away from the terminal.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div
        className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border px-1.5"
        role="toolbar"
        aria-label="Workspace actions"
      >
        <IconButton
          label="Add project"
          tooltip={hint("Add project", "add-project")}
          icon="add-project"
          onClick={(event) => props.onAddProject(event.currentTarget)}
        />
        <IconButton
          label="New task"
          tooltip={hint("New task", "new-task")}
          icon="task"
          disabled={selection.projectId === undefined}
          onClick={(event) => props.onNewTask(event.currentTarget)}
        />
        <IconButton
          label="New terminal"
          tooltip={hint("New terminal", "new-terminal")}
          icon="terminal"
          onClick={props.onNewTerminal}
        />
        <IconButton
          label="New agent session"
          tooltip={hint("New agent session", "new-agent")}
          icon="agent"
          disabled={selection.taskId === null}
          onClick={(event) => props.onNewAgent(event.currentTarget)}
        />
        <IconButton
          label="Find task"
          tooltip={hint("Find task", "find-task")}
          icon="find"
          onClick={(event) => props.onFindTask(event.currentTarget)}
        />
        <IconButton
          label="Command palette"
          tooltip={hint("Command palette", "command-palette")}
          icon="palette"
          onClick={(event) => props.onOpenPalette(event.currentTarget)}
        />
        <IconButton
          label="Open board"
          tooltip={hint("Open board", "board")}
          icon="board"
          onClick={props.onOpenBoard}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul className="m-0 list-none p-0">
          {tree.projects.map((node) => (
            <ProjectGroup
              key={node.project.id}
              node={node}
              selection={selection}
              collapsed={closedProjects.has(node.project.id)}
              onToggle={toggleProject}
              onSelectProject={props.onSelectProject}
              renderTask={renderTask}
            />
          ))}
          {tree.loose.length > 0 && (
            <li>
              <TreeRow project current={selection.taskId === null}>
                <span className="w-8 shrink-0" aria-hidden />
                <Button
                  variant={selection.taskId === null ? "secondary" : "ghost"}
                  layout="tree"
                  aria-label="No task"
                  onClick={props.onSelectLoose}
                >
                  <span className="min-w-0 flex-1 truncate">No task</span>
                  <span className="text-xs text-muted-foreground">{tree.loose.length}</span>
                </Button>
              </TreeRow>
              <TreeIndent>
                <ul>
                  {tree.loose.map((entry) => (
                    <TerminalRow
                      key={entry.terminal.id}
                      entry={entry}
                      current={entry.id === selection.entryId}
                      onSelect={() => props.onSelectEntry(entry)}
                      onClose={() => props.onCloseTerminal(entry.terminal.id)}
                      onRename={
                        entry.id === selection.entryId
                          ? () => props.onRenameEntry(entry)
                          : undefined
                      }
                    />
                  ))}
                </ul>
              </TreeIndent>
            </li>
          )}
        </ul>
      </div>
    </nav>
  );
}

function TerminalRow({
  entry,
  current,
  onSelect,
  onClose,
  onRename,
}: {
  entry: TerminalEntry;
  current: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename?: (() => void) | undefined;
}) {
  const { terminal } = entry;
  const label = terminalLabel(terminal);
  const {
    observe: observeTerminal,
    clipped: terminalClipped,
    display: terminalDisplay,
  } = useTruncatedText(label);
  const select = (
    <Button
      variant={current ? "secondary" : "ghost"}
      layout="tree"
      aria-label={label}
      aria-current={current ? "true" : undefined}
      onClick={onSelect}
    >
      <span
        ref={observeTerminal}
        className={cn("min-w-0 flex-1 truncate", terminal.exit && "text-muted-foreground")}
      >
        {terminalDisplay}
      </span>
      {terminal.exit && <Badge variant="secondary">exited ({terminal.exit.exitCode})</Badge>}
    </Button>
  );
  return (
    <li>
      <TreeRow current={current}>
        {terminalClipped ? <Hint content={label}>{select}</Hint> : select}
        <OverflowMenu label={`Terminal actions for ${label}`}>
          {onRename && <DropdownMenuItem onClick={onRename}>Rename…</DropdownMenuItem>}
          <DropdownMenuItem variant="destructive" onClick={onClose}>
            Close terminal…
          </DropdownMenuItem>
        </OverflowMenu>
      </TreeRow>
    </li>
  );
}

function SessionRow({
  entry,
  label,
  current,
  onSelect,
  onStop,
  onRestart,
  onRemove,
  onRename,
  hint,
}: {
  entry: SessionEntry;
  label: string | undefined;
  current: boolean;
  onSelect: () => void;
  onStop: () => void;
  onRestart: () => void;
  onRemove: () => void;
  onRename?: (() => void) | undefined;
  hint: (label: string, action: ActionId) => string;
}) {
  const { session } = entry;
  const running = session.state === "running";
  const { badge, note } = describeSessionState(session);
  const status = sessionStatus(session);
  const name = label ?? session.kind;
  const launch = compactLaunchLabel(session);
  const launchDetails = session.launch ? launchLine(session)?.details : undefined;
  const title = [launchDetails, status?.message, note].filter(Boolean).join("\n") || undefined;
  const { observe, clipped, display } = useTruncatedText(name);
  const select = (
    <Button
      variant={current ? "secondary" : "ghost"}
      layout="tree"
      aria-label={[name, launch, badge].filter(Boolean).join(" ")}
      aria-current={current ? "true" : undefined}
      title={title}
      onClick={onSelect}
      onKeyDown={(event) => {
        // Enter on the selected session that is not running starts it again.
        if (event.key !== "Enter" || !current || running) return;
        event.preventDefault();
        onRestart();
      }}
    >
      <span
        ref={observe}
        className={cn("min-w-0 flex-1 truncate", running ? undefined : "text-muted-foreground")}
      >
        {display}
      </span>
      {launch && running && (
        <Badge variant="secondary" layout="truncate" title={launchDetails}>
          <span className="truncate">{launch}</span>
        </Badge>
      )}
      {badge && <span className="text-muted-foreground"> {badge}</span>}
    </Button>
  );
  return (
    <li>
      <TreeRow current={current}>
        <StatusIndicator status={status} />
        {clipped ? <Hint content={name}>{select}</Hint> : select}
        {running ? (
          <IconButton
            label={`stop ${name}`}
            tooltip={hint(`Stop ${name}`, "stop-session")}
            icon="stop"
            onClick={onStop}
          />
        ) : (
          <IconButton
            label={`restart ${name}`}
            tooltip={hint(`Restart ${name}`, "restart-session")}
            icon="restart"
            onClick={onRestart}
          />
        )}
        <OverflowMenu label={`Session actions for ${name}`}>
          {onRename && <DropdownMenuItem onClick={onRename}>Rename…</DropdownMenuItem>}
          <DropdownMenuItem variant="destructive" onClick={onRemove}>
            Remove session…
          </DropdownMenuItem>
        </OverflowMenu>
      </TreeRow>
    </li>
  );
}

function TaskRow({
  node,
  selection,
  open,
  onToggle,
  onSelect,
  onToggleSettle,
  onRemove,
  onSelectEntry,
  onStop,
  onRestart,
  onRemoveSession,
  onRenameEntry,
  onViewSource,
  hint,
}: {
  node: TaskNode;
  selection: Selection;
  open: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onToggleSettle: () => void;
  onRemove: () => void;
  onSelectEntry: (entry: Entry) => void;
  onStop: (session: Session) => void;
  onRestart: (session: Session) => void;
  onRemoveSession: (session: Session) => void;
  onRenameEntry: (entry: Entry) => void;
  onViewSource?: ((opener?: HTMLElement) => void) | undefined;
  hint: (label: string, action: ActionId) => string;
}) {
  const { task, sessions } = node;
  const status = taskStatus(sessions.map((entry) => entry.session))?.status;
  const labels = sessionLabels(sessions.map((entry) => entry.session));
  const current = task.id === selection.taskId;
  const {
    observe: observeTitle,
    clipped: titleClipped,
    display: titleDisplay,
  } = useTruncatedText(task.title);
  const {
    observe: observeBranch,
    clipped: branchClipped,
    display: branchDisplay,
  } = useTruncatedText(task.branch, "middle");
  const clipped = titleClipped || branchClipped;
  const sourceTrigger = useRef<HTMLButtonElement>(null);
  const select = (
    <Button
      variant={current ? "secondary" : "ghost"}
      layout="tree"
      aria-label={task.title}
      aria-current={current ? "true" : undefined}
      title={status?.message}
      onClick={onSelect}
    >
      <span
        ref={observeTitle}
        className={cn(
          "min-w-0 flex-1 truncate",
          task.state === "settled" && "text-muted-foreground",
        )}
      >
        {titleDisplay}
      </span>
      {task.branch && (
        <span ref={observeBranch} className="w-1/4 shrink-0 truncate text-xs text-muted-foreground">
          {branchDisplay}
        </span>
      )}
    </Button>
  );
  return (
    <li>
      <TreeRow current={current}>
        {sessions.length > 0 ? (
          <IconButton
            label={`${open ? "Collapse" : "Expand"} sessions for ${task.title}`}
            icon={open ? "collapse" : "expand"}
            aria-expanded={open}
            disabled={current}
            onClick={onToggle}
          />
        ) : (
          <span className="w-8 shrink-0" aria-hidden />
        )}
        <StatusIndicator status={status} />
        {clipped ? (
          <Hint
            content={
              <span className="block">
                <span className="block">{task.title}</span>
                {task.branch && <span className="block text-muted-foreground">{task.branch}</span>}
              </span>
            }
          >
            {select}
          </Hint>
        ) : (
          select
        )}
        <OverflowMenu label={`Task actions for ${task.title}`} triggerRef={sourceTrigger}>
          {onViewSource && (
            <DropdownMenuItem
              onClick={(event) => onViewSource(sourceTrigger.current ?? event.currentTarget)}
            >
              View issue source…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={onToggleSettle}>
            {task.state === "active" ? "Settle task" : "Unsettle task"}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={onRemove}>
            Remove task…
          </DropdownMenuItem>
        </OverflowMenu>
      </TreeRow>
      {open && sessions.length > 0 && (
        <TreeIndent>
          <ul>
            {sessions.map((entry) => (
              <SessionRow
                key={entry.session.id}
                entry={entry}
                label={labels.get(entry.session.id)}
                current={entry.session.id === selection.entryId}
                onSelect={() => onSelectEntry(entry)}
                onStop={() => onStop(entry.session)}
                onRestart={() => onRestart(entry.session)}
                onRemove={() => onRemoveSession(entry.session)}
                onRename={
                  entry.session.id === selection.entryId ? () => onRenameEntry(entry) : undefined
                }
                hint={hint}
              />
            ))}
          </ul>
        </TreeIndent>
      )}
    </li>
  );
}

function ProjectGroup({
  node,
  selection,
  collapsed,
  onToggle,
  onSelectProject,
  renderTask,
}: {
  node: ProjectNode;
  selection: Selection;
  collapsed: boolean;
  onToggle: (projectId: string) => void;
  onSelectProject: (project: Project) => void;
  renderTask: (task: TaskNode) => ReactNode;
}) {
  const { project, active, settled } = node;
  const holdsCurrent = [...active, ...settled].some(({ task }) => task.id === selection.taskId);
  const settledCurrent = settled.some(({ task }) => task.id === selection.taskId);
  const open = !collapsed || holdsCurrent;
  const status = projectStatus(active, settled);
  const {
    observe: observeProject,
    clipped: projectClipped,
    display: projectDisplay,
  } = useTruncatedText(project.name);
  const select = (
    <Button
      variant={project.id === selection.projectId ? "secondary" : "ghost"}
      layout="tree"
      aria-label={project.name}
      aria-current={project.id === selection.projectId ? "true" : undefined}
      onClick={() => {
        if (!open) onToggle(project.id);
        onSelectProject(project);
      }}
    >
      <span ref={observeProject} className="min-w-0 flex-1 truncate">
        {projectDisplay}
      </span>
      {!open && (
        <span className="text-xs text-muted-foreground">{active.length + settled.length}</span>
      )}
    </Button>
  );
  return (
    <li>
      <TreeRow project current={project.id === selection.projectId}>
        <IconButton
          label={`${open ? "Collapse" : "Expand"} ${project.name}`}
          icon={open ? "collapse" : "expand"}
          aria-expanded={open}
          disabled={holdsCurrent}
          onClick={() => onToggle(project.id)}
        />
        {!open && status && <StatusIndicator status={status} />}
        {projectClipped ? <Hint content={project.name}>{select}</Hint> : select}
      </TreeRow>
      {open && (
        <TreeIndent>
          <ul>
            {active.map(renderTask)}
            {settled.length > 0 && (
              <SettledGroup tasks={settled} holdsCurrent={settledCurrent} renderTask={renderTask} />
            )}
          </ul>
        </TreeIndent>
      )}
    </li>
  );
}

function SettledGroup({
  tasks,
  holdsCurrent,
  renderTask,
}: {
  tasks: readonly TaskNode[];
  holdsCurrent: boolean;
  renderTask: (task: TaskNode) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const open = expanded || holdsCurrent;
  return (
    <li>
      <TreeRow>
        <Button
          variant="ghost"
          layout="tree"
          aria-expanded={open}
          disabled={holdsCurrent}
          onClick={() => setExpanded((each) => !each)}
        >
          <Icon name={open ? "collapse" : "expand"} />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            Settled ({tasks.length})
          </span>
        </Button>
      </TreeRow>
      {open && <ul>{tasks.map(renderTask)}</ul>}
    </li>
  );
}

/** The most urgent status of a project, for the shelf header while it is collapsed. */
function projectStatus(
  active: readonly TaskNode[],
  settled: readonly TaskNode[],
): TaskStatus["status"] | undefined {
  let best: TaskStatus["status"] | undefined;
  for (const { sessions } of [...active, ...settled]) {
    const status = taskStatus(sessions.map((entry) => entry.session))?.status;
    if (!status) continue;
    if (!best || compareStatuses(status, best) < 0) best = status;
  }
  return best;
}
