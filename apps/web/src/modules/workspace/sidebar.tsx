import {
  attentionWord,
  compareStatuses,
  formatAge,
  isUnseenDone,
  taskStatus,
  type TaskStatus,
} from "@corral/client/agent-status";
import type {
  FlatSection,
  FlatSidebar,
  FlatTaskNode,
  ProjectNode,
  Selection,
  TaskNode,
  TerminalEntry,
  WorkspaceTree,
} from "@corral/client/workspace-tree";
import type { ActionId, ClientConfig } from "@corral/protocol/config";
import type { AgentStatus, Project, Task, TaskChanges, TerminalInfo } from "@corral/protocol/rpc";
import { useRef, useState } from "react";
import { useNow } from "../../common/hooks/use-now.ts";
import { cn } from "../../common/lib/cn.ts";
import {
  Button,
  Badge,
  IconButton,
  Icon,
  DropdownMenuItem,
  OverflowMenu,
  Hint,
  Kbd,
  TreeIndent,
  TreeRow,
  useTruncatedText,
} from "../../common/ui/index.ts";
import { formatBinding } from "../keymap/index.ts";
import { StatusIndicator } from "../status/index.ts";

export function terminalLabel(terminal: TerminalInfo): string {
  if (terminal.label) return terminal.label;
  const program = terminal.command.split("/").pop() || terminal.command;
  const folder = terminal.cwd.replace(/\/+$/, "").split("/").pop() || "/";
  return `${program} · ${folder}`;
}

/** Time labels in rows are read at a glance and must not go stale while the window sits open. */
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

interface SidebarProps {
  tree: WorkspaceTree;
  selection: Selection;
  /**
   * The flat list when the sidebar lists tasks flat by status (`layout.md`, **Sidebar**); absent
   * in project mode, where the tree is shown instead. Built once by the caller.
   */
  flat?: FlatSidebar | undefined;
  /** Each task's changed files; a row shows the compact `+N −M` only when one is non-zero. */
  changes?: ReadonlyMap<string, TaskChanges> | undefined;
  /** Effective bindings for the tooltips and the search hint; absent in a bare sidebar test. */
  config?: ClientConfig | undefined;
  onSelectProject: (project: Project) => void;
  onSelectTask: (task: Task) => void;
  onSelectLoose: () => void;
  /** A loose terminal (the Scratch section); sessions are tabs, not rows. */
  onSelectTerminal: (entry: TerminalEntry) => void;
  onRenameTerminal: (entry: TerminalEntry) => void;
  onCloseTerminal: (id: string) => void;
  onRenameTask: (task: Task, opener?: HTMLElement) => void;
  onToggleSettle: (task: Task) => void;
  onRemoveTask: (task: Task) => void;
  /** Opens the controlled source dialog; only tasks with a source offer it. */
  onViewSource?: (task: Task, opener?: HTMLElement) => void;
  /** `project` is set by a project group's "new task here"; absent from the header button. */
  onNewTask: (project?: Project, opener?: HTMLElement) => void;
  onFindTask: (opener?: HTMLElement) => void;
}

/**
 * The sidebar lists tasks only (`layout.md`, **Sidebar**): a 44 px header with search and new
 * task, the flat or project-grouped task list, the Scratch section for loose terminals, and the
 * footer the shell draws below it.
 */
export function Sidebar(props: SidebarProps) {
  const { tree, selection, config, flat, changes } = props;
  const [closedProjects, setClosedProjects] = useState<ReadonlySet<string>>(new Set());
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

  const renderTask = (node: TaskNode) => (
    <TaskRow
      key={node.task.id}
      node={node}
      selection={selection}
      changes={changes?.get(node.task.id)}
      now={now}
      onSelect={() => {
        openProject(node.task.projectId);
        props.onSelectTask(node.task);
      }}
      onToggleSettle={() => props.onToggleSettle(node.task)}
      onRemove={() => props.onRemoveTask(node.task)}
      onRename={(opener) => props.onRenameTask(node.task, opener)}
      onViewSource={
        node.task.source && props.onViewSource
          ? (opener) => props.onViewSource?.(node.task, opener)
          : undefined
      }
    />
  );

  const renderFlatTask = (row: FlatTaskNode) => (
    <TaskRow
      key={row.task.id}
      node={row}
      selection={selection}
      changes={changes?.get(row.task.id)}
      now={now}
      row={{ projectName: row.project.name, status: row.status, unseen: row.unseen }}
      onSelect={() => props.onSelectTask(row.task)}
      onToggleSettle={() => props.onToggleSettle(row.task)}
      onRemove={() => props.onRemoveTask(row.task)}
      onRename={(opener) => props.onRenameTask(row.task, opener)}
      onViewSource={
        row.task.source && props.onViewSource
          ? (opener) => props.onViewSource?.(row.task, opener)
          : undefined
      }
    />
  );

  const scratch = (
    <Scratch
      entries={tree.loose}
      selection={selection}
      onSelectLoose={props.onSelectLoose}
      onSelectTerminal={props.onSelectTerminal}
      onCloseTerminal={props.onCloseTerminal}
      onRenameTerminal={props.onRenameTerminal}
    />
  );

  return (
    <nav
      className="flex min-h-0 flex-1 flex-col"
      aria-label="workspace"
      // Clicking must not take keyboard focus away from the terminal.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-1.5">
        <Button
          variant="ghost"
          layout="tree"
          aria-label="Search tasks"
          onClick={(event) => props.onFindTask(event.currentTarget)}
        >
          <Icon name="find" />
          <span className="min-w-0 flex-1 truncate text-left">Search tasks</span>
          {config && <Kbd>{formatBinding(config, "find-task")}</Kbd>}
        </Button>
        <IconButton
          label="New task"
          tooltip={hint("New task", "new-task")}
          icon="task"
          disabled={selection.projectId === undefined}
          onClick={(event) => props.onNewTask(undefined, event.currentTarget)}
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
            {scratch}
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
                onNewTask={(opener) => props.onNewTask(node.project, opener)}
                renderTask={renderTask}
              />
            ))}
            {scratch}
          </ul>
        )}
      </div>
    </nav>
  );
}

/** Loose terminals outside any task, listed one line each at the bottom (`layout.md`, **Scratch**). */
function Scratch({
  entries,
  selection,
  onSelectLoose,
  onSelectTerminal,
  onCloseTerminal,
  onRenameTerminal,
}: {
  entries: readonly TerminalEntry[];
  selection: Selection;
  onSelectLoose: () => void;
  onSelectTerminal: (entry: TerminalEntry) => void;
  onCloseTerminal: (id: string) => void;
  onRenameTerminal: (entry: TerminalEntry) => void;
}) {
  if (entries.length === 0) return undefined;
  return (
    <li>
      <TreeRow>
        <Button
          variant={selection.taskId === null ? "secondary" : "ghost"}
          layout="tree"
          aria-label="Scratch"
          aria-current={selection.taskId === null ? "true" : undefined}
          onClick={onSelectLoose}
        >
          <Icon name="terminal" />
          <span className="min-w-0 flex-1 truncate text-left">Scratch</span>
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
              onSelect={() => onSelectTerminal(entry)}
              onClose={() => onCloseTerminal(entry.terminal.id)}
              onRename={entry.id === selection.entryId ? () => onRenameTerminal(entry) : undefined}
            />
          ))}
        </ul>
      </TreeIndent>
    </li>
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

/** Flat mode's precomputed row facts; project mode derives the same from the node. */
interface FlatRowFacts {
  /** Flat mode names the project on the row's second line; the project group already does. */
  projectName: string;
  status: AgentStatus | undefined;
  unseen: boolean;
}

function TaskRow({
  node,
  selection,
  changes,
  now,
  row,
  onSelect,
  onToggleSettle,
  onRemove,
  onRename,
  onViewSource,
}: {
  node: TaskNode;
  selection: Selection;
  changes: TaskChanges | undefined;
  now: number;
  /** Absent in project mode, which derives the status and the unseen mark itself. */
  row?: FlatRowFacts | undefined;
  onSelect: () => void;
  onToggleSettle: () => void;
  onRemove: () => void;
  onRename: (opener?: HTMLElement) => void;
  onViewSource?: ((opener?: HTMLElement) => void) | undefined;
}) {
  const { task, sessions } = node;
  const status = row?.status ?? taskStatus(sessions.map((entry) => entry.session))?.status;
  const unseen = row?.unseen ?? isUnseenDone(task, status);
  const current = task.id === selection.taskId;
  const agent = sessions.find(({ session }) => session.kind !== "shell")?.session.kind;
  const detail =
    [
      row?.projectName,
      task.ownsWorktree ? task.branch : undefined,
      agent,
      sessions.length > 1 ? `${sessions.length} sessions` : undefined,
      // The compact counts appear only when the task changed something (`layout.md`, **Sidebar**).
      changes !== undefined && (changes.additions > 0 || changes.deletions > 0)
        ? `+${changes.additions} −${changes.deletions}`
        : undefined,
    ]
      .filter(Boolean)
      .join(" · ") || undefined;
  const {
    observe: observeTitle,
    clipped: titleClipped,
    display: titleDisplay,
  } = useTruncatedText(task.title);
  const {
    observe: observeDetail,
    clipped: detailClipped,
    display: detailDisplay,
  } = useTruncatedText(detail ?? "");
  const right = attentionWord(status) ?? formatAge(now, status?.updatedAt ?? task.createdAt);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const select = (
    <Button
      variant={current ? "secondary" : "ghost"}
      size="row"
      layout="tree"
      // The second line lives in an overridden subtree, so the accessible name carries it.
      aria-label={detail === undefined ? task.title : `${task.title} — ${detail}`}
      aria-current={current ? "true" : undefined}
      title={status?.message}
      onClick={onSelect}
    >
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
    </Button>
  );
  return (
    <li>
      <TreeRow current={current}>
        <StatusIndicator status={status} muted={status?.state === "done" && !unseen} />
        {titleClipped || detailClipped ? (
          <Hint
            content={
              <span className="block">
                <span className="block">{task.title}</span>
                {detail !== undefined && (
                  <span className="block text-muted-foreground">{detail}</span>
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
    </li>
  );
}

function ProjectGroup({
  node,
  selection,
  collapsed,
  onToggle,
  onSelectProject,
  onNewTask,
  renderTask,
}: {
  node: ProjectNode;
  selection: Selection;
  collapsed: boolean;
  onToggle: (projectId: string) => void;
  onSelectProject: (project: Project) => void;
  onNewTask: (opener?: HTMLElement) => void;
  renderTask: (node: TaskNode) => React.ReactNode;
}) {
  const { project, active, settled } = node;
  const holdsCurrent = [...active, ...settled].some(({ task }) => task.id === selection.taskId);
  const settledCurrent = settled.some(({ task }) => task.id === selection.taskId);
  const open = !collapsed || holdsCurrent;
  const status = projectStatus(active, settled);
  const count = active.length + settled.length;
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
      <span className="shrink-0 text-xs text-muted-foreground">{count}</span>
    </Button>
  );
  return (
    <li>
      <TreeRow project current={project.id === selection.projectId} className="group">
        <IconButton
          label={`${open ? "Collapse" : "Expand"} ${project.name}`}
          icon={open ? "collapse" : "expand"}
          aria-expanded={open}
          disabled={holdsCurrent}
          onClick={() => onToggle(project.id)}
        />
        {!open && status && <StatusIndicator status={status} />}
        {projectClipped ? <Hint content={project.name}>{select}</Hint> : select}
        <span className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <IconButton
            label={`New task in ${project.name}`}
            icon="add"
            onClick={(event) => onNewTask(event.currentTarget)}
          />
        </span>
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
  renderItem: (item: T) => React.ReactNode;
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
