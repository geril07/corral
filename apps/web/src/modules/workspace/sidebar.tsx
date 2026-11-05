import {
  attentionWord,
  compareStatuses,
  formatAge,
  isSeenDone,
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
import type {
  AgentStatus,
  Project,
  PullRequest,
  Task,
  TaskChanges,
  TerminalInfo,
} from "@corral/protocol/rpc";
import { useEffect, useRef, useState } from "react";
import { useNow } from "../../common/hooks/use-now.ts";
import { cn } from "../../common/lib/cn.ts";
import {
  Button,
  Badge,
  IconButton,
  Icon,
  DropdownMenuItem,
  RowMenu,
  Hint,
  TreeIndent,
  TreeRow,
  useTruncatedText,
} from "../../common/ui/index.ts";
import { changeCounts, pullRequestShortText } from "../changes/index.ts";
import { formatBinding } from "../keymap/index.ts";
import { StatusIndicator } from "../status/index.ts";
import { SIDEBAR_ROW_SELECTOR, sidebarRowOf } from "./sidebar-focus.ts";

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
   * The project composer the main area shows, when one is open (`layout.md`, **New task view**).
   * The sidebar reads the same value: no row is current while it is open, and opening it opens
   * the composer's project group.
   */
  composing?: { project?: Project | undefined; opened: number } | undefined;
  /**
   * The flat list when the sidebar lists tasks flat by status (`layout.md`, **Sidebar**); absent
   * in project mode, where the tree is shown instead. Built once by the caller.
   */
  flat?: FlatSidebar | undefined;
  /** Each task's changed files; a row shows the compact `+N −M` only when one is non-zero. */
  changes?: ReadonlyMap<string, TaskChanges> | undefined;
  /** Each task's pull or merge request; a row names it only when one is linked. */
  pullRequests?: ReadonlyMap<string, PullRequest> | undefined;
  /** Effective bindings for the tooltips and the search hint; absent in a bare sidebar test. */
  config?: ClientConfig | undefined;
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
  onToggleSidebar?: (() => void) | undefined;
  onToggleGrouping?: (() => void) | undefined;
  /** Escape in the list: the keyboard returns to where `prefix w` took it from. */
  onLeaveList?: (() => void) | undefined;
  /** Enter on the row that is already open: the task's terminal, chat or composer takes it back. */
  onReturnToWorkspace?: (() => void) | undefined;
}

/**
 * The sidebar lists tasks only (`layout.md`, **Sidebar**): a 44 px header with search and new
 * task, the flat or project-grouped task list, the Scratch section for loose terminals, and the
 * footer the shell draws below it.
 */
export function Sidebar(props: SidebarProps) {
  const { tree, selection, config, flat, changes, pullRequests, composing } = props;
  const [closedProjects, setClosedProjects] = useState<ReadonlySet<string>>(new Set());
  const now = useNow(AGE_REFRESH_MS);
  // A composer is a view of its project, not a row: while it is open no task, project or loose
  // terminal is current, and the same value is what the main area shows.
  const shownSelection = composing === undefined ? selection : undefined;
  const composingProjectId = composing?.project?.id;
  // The composer's project is the open group: its closed state is keyed by the open, so each
  // composer opens the group it belongs to while the other groups keep what the user chose.
  // Collapsing it is scoped to that composer, and nothing has to be changed from an effect.
  const groupKey = (projectId: string) =>
    composingProjectId === projectId ? `${projectId}:${composing?.opened}` : projectId;

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
      projectName={
        node.task.state === "settled"
          ? tree.projects.find((item) => item.project.id === node.task.projectId)?.project.name
          : undefined
      }
      selection={shownSelection}
      changes={changes?.get(node.task.id)}
      pullRequest={pullRequests?.get(node.task.id)}
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
      selection={shownSelection}
      changes={changes?.get(row.task.id)}
      pullRequest={pullRequests?.get(row.task.id)}
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

  const settled = flat?.settled ?? tree.projects.flatMap((project) => project.settled);
  const scratch = (
    <Scratch
      entries={tree.loose}
      selection={shownSelection}
      onSelectLoose={props.onSelectLoose}
      onSelectTerminal={props.onSelectTerminal}
      onCloseTerminal={props.onCloseTerminal}
      onRenameTerminal={props.onRenameTerminal}
    />
  );

  // Escape is taken in the capture phase: a clipped row shows its tooltip on focus, and Base UI's
  // trigger closes it on Escape before a bubbling handler sees the key. Leaving the list is the
  // row's own action, so it runs first and the tooltip closes with the lost focus.
  const onKeyDownCapture = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || sidebarRowOf(event) === null) return;
    event.preventDefault();
    event.stopPropagation();
    props.onLeaveList?.();
  };

  // Arrows walk the rows; Enter is the row's own button activation.
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const row = sidebarRowOf(event);
    if (!row) return;
    if (event.key === "Enter") {
      // The button opens its row itself; only the row that is already open has no remount to
      // return the keyboard, so this is the one case that hands it back explicitly.
      if (row.getAttribute("aria-current") === "true") props.onReturnToWorkspace?.();
      return;
    }
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(SIDEBAR_ROW_SELECTOR)];
    const index = rows.indexOf(row);
    const target =
      event.key === "ArrowDown"
        ? index + 1
        : event.key === "ArrowUp"
          ? index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? rows.length - 1
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, target))]?.focus();
  };

  return (
    <nav
      className="flex min-h-0 flex-1 flex-col"
      aria-label="workspace"
      onKeyDownCapture={onKeyDownCapture}
      onKeyDown={onKeyDown}
      // Clicking must not take keyboard focus away from the terminal.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="flex h-(--chrome-header) shrink-0 items-center justify-between px-3">
        <span className="text-sm font-semibold">corral</span>
        {props.onToggleSidebar && (
          <IconButton label="Hide sidebar" icon="hide-sidebar" onClick={props.onToggleSidebar} />
        )}
      </div>
      <div className="flex h-(--chrome-row) shrink-0 items-center gap-1 px-1.5">
        <Button
          variant="ghost"
          layout="tree"
          aria-label="Search tasks"
          title={hint("Search tasks", "find-task")}
          onClick={(event) => props.onFindTask(event.currentTarget)}
        >
          <Icon name="find" />
          <span className="min-w-0 flex-1 truncate text-left">Search</span>
        </Button>
        {props.onToggleGrouping && (
          <IconButton
            label={flat ? "Group tasks by project" : "Group tasks by status"}
            tooltip={hint("Toggle sidebar grouping", "sidebar-mode")}
            icon="grouping"
            onClick={props.onToggleGrouping}
          />
        )}
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
            {scratch}
          </ul>
        ) : (
          <ul className="m-0 list-none p-0">
            {tree.projects.map((node) => (
              <ProjectGroup
                key={node.project.id}
                node={node}
                selection={shownSelection}
                collapsed={closedProjects.has(groupKey(node.project.id))}
                onToggle={toggleProject}
                groupKey={groupKey(node.project.id)}
                onNewTask={(opener) => props.onNewTask(node.project, opener)}
                renderTask={renderTask}
              />
            ))}
            {scratch}
          </ul>
        )}
      </div>
      {settled.length > 0 && (
        <ul className="m-0 shrink-0 list-none p-0">
          <SettledGroup
            items={settled}
            currentTaskId={shownSelection?.taskId ?? null}
            renderItem={renderTask}
          />
        </ul>
      )}
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
  selection: Selection | undefined;
  onSelectLoose: () => void;
  onSelectTerminal: (entry: TerminalEntry) => void;
  onCloseTerminal: (id: string) => void;
  onRenameTerminal: (entry: TerminalEntry) => void;
}) {
  if (entries.length === 0) return undefined;
  return (
    <li>
      <TreeRow>
        <Button variant="ghost" layout="tree" aria-label="Scratch" onClick={onSelectLoose}>
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
              current={entry.id === selection?.entryId}
              onSelect={() => onSelectTerminal(entry)}
              onClose={() => onCloseTerminal(entry.terminal.id)}
              onRename={entry.id === selection?.entryId ? () => onRenameTerminal(entry) : undefined}
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
      data-sidebar-row
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
        <RowMenu
          label={`Terminal actions for ${label}`}
          hint={terminalClipped ? label : undefined}
          trigger={select}
        >
          {onRename && <DropdownMenuItem onClick={onRename}>Rename…</DropdownMenuItem>}
          <DropdownMenuItem variant="destructive" onClick={onClose}>
            Close terminal…
          </DropdownMenuItem>
        </RowMenu>
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
  pullRequest,
  now,
  row,
  projectName,
  onSelect,
  onToggleSettle,
  onRemove,
  onRename,
  onViewSource,
}: {
  node: TaskNode;
  selection: Selection | undefined;
  changes: TaskChanges | undefined;
  pullRequest: PullRequest | undefined;
  now: number;
  /** Absent in project mode, which derives the status and the unseen mark itself. */
  row?: FlatRowFacts | undefined;
  projectName?: string | undefined;
  onSelect: () => void;
  onToggleSettle: () => void;
  onRemove: () => void;
  onRename: (opener?: HTMLElement) => void;
  onViewSource?: ((opener?: HTMLElement) => void) | undefined;
}) {
  const { task, sessions } = node;
  const status = row?.status ?? taskStatus(sessions.map((entry) => entry.session))?.status;
  const unseen = row?.unseen ?? isUnseenDone(task, status);
  const current = task.id === selection?.taskId;
  const agent = sessions.find(({ session }) => session.kind !== "shell")?.session.kind;
  const detail =
    [
      row?.projectName ?? projectName,
      task.ownsWorktree ? task.branch : undefined,
      agent,
      sessions.length > 1 ? `${sessions.length} sessions` : undefined,
      // The compact counts appear only when the task changed something (`layout.md`, **Sidebar**),
      // and the request's state only when one is linked.
      changeCounts(changes),
      pullRequest === undefined ? undefined : pullRequestShortText(pullRequest),
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
      data-sidebar-row
      // The second line lives in an overridden subtree, so the accessible name carries it.
      aria-label={detail === undefined ? task.title : `${task.title} — ${detail}`}
      aria-current={current ? "true" : undefined}
      ref={menuTrigger}
      title={titleClipped || detailClipped ? undefined : status?.message}
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
        <StatusIndicator status={status} muted={isSeenDone(status, unseen)} />
        <RowMenu
          label={`Task actions for ${task.title}`}
          hint={
            titleClipped || detailClipped ? (
              <span className="block">
                <span className="block">{task.title}</span>
                {detail !== undefined && (
                  <span className="block text-muted-foreground">{detail}</span>
                )}
              </span>
            ) : undefined
          }
          trigger={select}
        >
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
        </RowMenu>
      </TreeRow>
    </li>
  );
}

function ProjectGroup({
  node,
  selection,
  collapsed,
  onToggle,
  groupKey,
  onNewTask,
  renderTask,
}: {
  node: ProjectNode;
  selection: Selection | undefined;
  collapsed: boolean;
  /** The closed set's key for this group; a composer keys its own project by the open. */
  groupKey: string;
  onToggle: (groupKey: string) => void;
  onNewTask: (opener?: HTMLElement) => void;
  renderTask: (node: TaskNode) => React.ReactNode;
}) {
  const { project, active } = node;
  const currentTask = active.find(({ task }) => task.id === selection?.taskId);
  const open = !collapsed;
  const status = projectStatus(active);
  const count = active.length;
  const {
    observe: observeProject,
    clipped: projectClipped,
    display: projectDisplay,
  } = useTruncatedText(project.name);
  // One control per project: the row itself discloses the group. The count stays in the row and
  // the action covers it on hover and keyboard focus, so neither reserves an action gutter.
  const select = (
    <Button
      variant="ghost"
      layout="tree"
      aria-label={project.name}
      aria-expanded={open}
      onClick={() => onToggle(groupKey)}
    >
      <Icon name={open ? "collapse" : "expand"} />
      {!open && status && <StatusIndicator status={status} />}
      <span ref={observeProject} className="min-w-0 flex-1 truncate">
        {projectDisplay}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground group-hover:invisible group-focus-within:invisible">
        {count}
      </span>
    </Button>
  );
  return (
    <li>
      <TreeRow project className="group relative">
        {projectClipped ? <Hint content={project.name}>{select}</Hint> : select}
        <span className="absolute inset-y-0 right-0 flex items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none">
          <IconButton
            label={`New task in ${project.name}`}
            icon="add"
            onClick={(event) => onNewTask(event.currentTarget)}
          />
        </span>
      </TreeRow>
      {open ? (
        <ul className="m-0 list-none p-0">{active.map(renderTask)}</ul>
      ) : (
        currentTask !== undefined && (
          <ul className="m-0 list-none p-0">{renderTask(currentTask)}</ul>
        )
      )}
    </li>
  );
}

function SettledGroup({
  items,
  currentTaskId,
  renderItem,
}: {
  items: readonly TaskNode[];
  currentTaskId: string | null;
  renderItem: (item: TaskNode) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [limit, setLimit] = useState(6);
  const list = useRef<HTMLUListElement>(null);
  const currentIndex = items.findIndex((item) => item.task.id === currentTaskId);
  const holdsCurrent = currentIndex >= 0;
  const open = expanded || holdsCurrent;
  const visible = Math.max(limit, currentIndex + 1);
  useEffect(() => {
    if (open && currentTaskId !== null)
      list.current
        ?.querySelector<HTMLElement>('[aria-current="true"]')
        ?.scrollIntoView({ block: "nearest" });
  }, [open, currentTaskId]);
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
      {open && (
        <>
          <ul ref={list} className="m-0 max-h-60 list-none overflow-y-auto p-0">
            {items.slice(0, visible).map(renderItem)}
          </ul>
          {visible < items.length && (
            <Button variant="ghost" onClick={() => setLimit((each) => each + 6)}>
              Show more
            </Button>
          )}
        </>
      )}
    </li>
  );
}

/** The most urgent status of a project, for the shelf header while it is collapsed. */
function projectStatus(active: readonly TaskNode[]): TaskStatus["status"] | undefined {
  let best: TaskStatus["status"] | undefined;
  for (const { sessions } of active) {
    const status = taskStatus(sessions.map((entry) => entry.session))?.status;
    if (!status) continue;
    if (!best || compareStatuses(status, best) < 0) best = status;
  }
  return best;
}
