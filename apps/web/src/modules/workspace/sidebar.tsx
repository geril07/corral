import {
  attentionWord,
  compareStatuses,
  formatAge,
  sessionStatus,
  taskStatus,
  type TaskStatus,
} from "@corral/client/agent-status";
import { sessionLabels } from "@corral/client/session-labels";
import { describeSessionState } from "@corral/client/session-state";
import type {
  Entry,
  FlatSection,
  FlatSidebar,
  FlatTaskNode,
  ProjectNode,
  SessionEntry,
  Selection,
  TaskNode,
  TerminalEntry,
  WorkspaceTree,
} from "@corral/client/workspace-tree";
import type { ActionId, ClientConfig } from "@corral/protocol/config";
import type { AgentStatus, Project, Session, Task, TerminalInfo } from "@corral/protocol/rpc";
import { useRef, useState, type ReactNode } from "react";
import { useNow } from "../../common/hooks/use-now.ts";
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

/** Time labels in flat rows are read at a glance and must not go stale while the window sits open. */
const AGE_REFRESH_MS = 30_000;

/** "Needs you 2": a flat section's header, with how many tasks it holds. */
function FlatSectionHeader({ section }: { section: FlatSection }) {
  return (
    <div className="flex w-full items-center justify-between px-2 py-1">
      <h2 className="m-0 text-xs font-medium text-muted-foreground">{section.label}</h2>
      <span className="text-xs text-muted-foreground">{section.tasks.length}</span>
    </div>
  );
}

/** Loose terminals, listed apart from the tasks in both modes, and only while some exist. */
function LooseTerminals({
  entries,
  selection,
  onSelectLoose,
  onSelectEntry,
  onCloseTerminal,
  onRenameEntry,
}: {
  entries: readonly TerminalEntry[];
  selection: Selection;
  onSelectLoose: () => void;
  onSelectEntry: (entry: Entry) => void;
  onCloseTerminal: (id: string) => void;
  onRenameEntry: (entry: Entry) => void;
}) {
  if (entries.length === 0) return undefined;
  return (
    <li>
      <TreeRow project current={selection.taskId === null}>
        <span className="w-8 shrink-0" aria-hidden />
        <Button
          variant={selection.taskId === null ? "secondary" : "ghost"}
          layout="tree"
          aria-label="No task"
          onClick={onSelectLoose}
        >
          <span className="min-w-0 flex-1 truncate">No task</span>
          <span className="text-xs text-muted-foreground">{entries.length}</span>
        </Button>
      </TreeRow>
      <TreeIndent>
        <ul>
          {entries.map((entry) => (
            <TerminalRow
              key={entry.terminal.id}
              entry={entry}
              current={entry.id === selection.entryId}
              onSelect={() => onSelectEntry(entry)}
              onClose={() => onCloseTerminal(entry.terminal.id)}
              onRename={entry.id === selection.entryId ? () => onRenameEntry(entry) : undefined}
            />
          ))}
        </ul>
      </TreeIndent>
    </li>
  );
}

interface SidebarProps {
  tree: WorkspaceTree;
  selection: Selection;
  /**
   * The flat list when the sidebar lists tasks flat by status (`layout.md`, **Sidebar**); absent
   * in project mode, where the tree is shown instead. Built once by the caller.
   */
  flat?: FlatSidebar | undefined;
  /** Effective bindings for the tooltips; absent in a bare sidebar test. */
  config?: ClientConfig;
  onSelectProject: (project: Project) => void;
  onSelectTask: (task: Task) => void;
  onSelectLoose: () => void;
  onSelectEntry: (entry: Entry) => void;
  /** The rename dialog's opener; the rows offer it in their overflow. */
  onRenameEntry: (entry: Entry) => void;
  onRenameTask: (task: Task, opener?: HTMLElement) => void;
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
  const { tree, selection, config, flat } = props;
  const [closedProjects, setClosedProjects] = useState<ReadonlySet<string>>(new Set());
  const [openTasks, setOpenTasks] = useState<ReadonlySet<string>>(new Set());
  const now = useNow(AGE_REFRESH_MS);

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
      onRename={(opener) => props.onRenameTask(node.task, opener)}
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

  const renderFlatTask = (row: FlatTaskNode) => (
    <TaskRow
      key={row.task.id}
      node={row}
      selection={selection}
      open={row.task.id === selection.taskId}
      onToggle={() => toggleTask(row.task.id)}
      onSelect={() => props.onSelectTask(row.task)}
      onToggleSettle={() => props.onToggleSettle(row.task)}
      onRemove={() => props.onRemoveTask(row.task)}
      onRename={(opener) => props.onRenameTask(row.task, opener)}
      onSelectEntry={props.onSelectEntry}
      onStop={props.onStopSession}
      onRestart={props.onRestartSession}
      onRemoveSession={props.onRemoveSession}
      onRenameEntry={props.onRenameEntry}
      onViewSource={
        row.task.source && props.onViewSource
          ? (opener) => props.onViewSource?.(row.task, opener)
          : undefined
      }
      flat={{ project: row.project, status: row.status, unseen: row.unseen, now }}
      hint={hint}
    />
  );

  const loose = (
    <LooseTerminals
      entries={tree.loose}
      selection={selection}
      onSelectLoose={props.onSelectLoose}
      onSelectEntry={props.onSelectEntry}
      onCloseTerminal={props.onCloseTerminal}
      onRenameEntry={props.onRenameEntry}
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
        {flat !== undefined ? (
          <ul className="m-0 list-none p-0">
            {flat.sections.map((section) => (
              <li key={section.kind}>
                <FlatSectionHeader section={section} />
                <ul className="m-0 list-none p-0">{section.tasks.map(renderFlatTask)}</ul>
              </li>
            ))}
            {flat.settled.length > 0 && (
              <SettledGroup
                items={flat.settled}
                holdsCurrent={flat.settled.some(({ task }) => task.id === selection.taskId)}
                renderItem={renderFlatTask}
              />
            )}
            {loose}
          </ul>
        ) : (
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
            {loose}
          </ul>
        )}
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

interface FlatRow {
  project: Project;
  status: AgentStatus | undefined;
  unseen: boolean;
  now: number;
}

function TaskRow({
  node,
  selection,
  open,
  onToggle,
  onSelect,
  onToggleSettle,
  onRemove,
  onRename,
  onSelectEntry,
  onStop,
  onRestart,
  onRemoveSession,
  onRenameEntry,
  onViewSource,
  flat,
  hint,
}: {
  node: TaskNode;
  selection: Selection;
  open: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onToggleSettle: () => void;
  onRemove: () => void;
  onRename: (opener?: HTMLElement) => void;
  onSelectEntry: (entry: Entry) => void;
  onStop: (session: Session) => void;
  onRestart: (session: Session) => void;
  onRemoveSession: (session: Session) => void;
  onRenameEntry: (entry: Entry) => void;
  onViewSource?: ((opener?: HTMLElement) => void) | undefined;
  /** Set in flat mode: its two-line row shows the project, the agent and the time, and unseen completion. */
  flat?: FlatRow | undefined;
  hint: (label: string, action: ActionId) => string;
}) {
  const { task, sessions } = node;
  const status = flat?.status ?? taskStatus(sessions.map((entry) => entry.session))?.status;
  const unseen = flat?.unseen ?? false;
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
  const agent = sessions.find(({ session }) => session.kind !== "shell")?.session.kind;
  const detail =
    flat === undefined
      ? undefined
      : [flat.project.name, task.ownsWorktree ? task.branch : undefined, agent]
          .filter(Boolean)
          .join(" · ");
  const {
    observe: observeDetail,
    clipped: detailClipped,
    display: detailDisplay,
  } = useTruncatedText(detail ?? "");
  const clipped = titleClipped || (flat === undefined ? branchClipped : detailClipped);
  const right =
    flat === undefined
      ? undefined
      : (attentionWord(status) ?? formatAge(flat.now, status?.updatedAt ?? task.createdAt));
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const select = (
    <Button
      variant={current ? "secondary" : "ghost"}
      size={flat === undefined ? "default" : "row"}
      layout="tree"
      // The two-line row's project, branch and agent live in an overridden subtree, so the
      // accessible name carries them; the name is the row's only full copy of that line.
      aria-label={detail === undefined ? task.title : `${task.title} — ${detail}`}
      aria-current={current ? "true" : undefined}
      title={status?.message}
      onClick={onSelect}
    >
      {flat === undefined ? (
        <span
          ref={observeTitle}
          className={cn(
            "min-w-0 flex-1 truncate",
            task.state === "settled" && "text-muted-foreground",
          )}
        >
          {titleDisplay}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              ref={observeTitle}
              className={cn(
                "min-w-0 flex-1 truncate",
                unseen && "font-semibold",
                task.state === "settled" && "text-muted-foreground",
              )}
            >
              {titleDisplay}
            </span>
            {unseen && (
              <span
                role="img"
                aria-label="unseen"
                className="size-1.5 shrink-0 rounded-full bg-foreground"
              />
            )}
            <span className="shrink-0 text-xs text-muted-foreground">{right}</span>
          </span>
          <span ref={observeDetail} className="min-w-0 truncate text-xs text-muted-foreground">
            {detailDisplay}
          </span>
        </span>
      )}
      {flat === undefined && task.branch && (
        <span ref={observeBranch} className="w-1/4 shrink-0 truncate text-xs text-muted-foreground">
          {branchDisplay}
        </span>
      )}
    </Button>
  );
  return (
    <li>
      <TreeRow current={current}>
        {flat !== undefined ? undefined : sessions.length > 0 ? (
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
                {flat !== undefined ? (
                  <span className="block text-muted-foreground">{detail}</span>
                ) : (
                  task.branch && <span className="block text-muted-foreground">{task.branch}</span>
                )}
              </span>
            }
          >
            {select}
          </Hint>
        ) : (
          select
        )}
        <OverflowMenu label={`Task actions for ${task.title}`} triggerRef={menuTrigger}>
          {onViewSource && (
            <DropdownMenuItem
              onClick={(event) => onViewSource(menuTrigger.current ?? event.currentTarget)}
            >
              View issue source…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={(event) => onRename(menuTrigger.current ?? event.currentTarget)}
          >
            Rename task…
          </DropdownMenuItem>
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
              <SettledGroup items={settled} holdsCurrent={settledCurrent} renderItem={renderTask} />
            )}
          </ul>
        </TreeIndent>
      )}
    </li>
  );
}

function SettledGroup<T>({
  items,
  holdsCurrent,
  renderItem,
}: {
  items: readonly T[];
  holdsCurrent: boolean;
  renderItem: (item: T) => ReactNode;
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
            Settled ({items.length})
          </span>
        </Button>
      </TreeRow>
      {open && <ul>{items.map(renderItem)}</ul>}
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
