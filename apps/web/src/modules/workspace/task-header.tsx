import { describeStatus, taskStatus } from "@corral/client/agent-status";
import type { TaskNode } from "@corral/client/workspace-tree";
import type { ActionId, ClientConfig } from "@corral/protocol/config";
import type { Project, Task } from "@corral/protocol/rpc";
import { useRef } from "react";
import {
  Badge,
  Button,
  DropdownMenuItem,
  IconButton,
  OverflowMenu,
  useTruncatedText,
} from "../../common/ui/index.ts";
import { formatBinding } from "../keymap/index.ts";
import { compactLaunchLabel } from "../sessions/index.ts";
import { StatusIndicator } from "../status/index.ts";

export interface TaskHeaderProps {
  node: TaskNode;
  /** Absent only if the task's project disappeared between the two watches. */
  project: Project | undefined;
  /** Effective bindings for the settle hint; absent in a bare header test. */
  config?: ClientConfig | undefined;
  onSettle: (task: Task) => void;
  onRename: (task: Task, opener?: HTMLElement) => void;
  onRemove: (task: Task) => void;
  /** Only tasks with an imported issue source offer it. */
  onViewSource?: ((task: Task, opener?: HTMLElement) => void) | undefined;
}

/**
 * The 40 px task header (`layout.md`, **Task header**): what the task is, what it is doing, the
 * agent behind it, and settle plus the task's menu. The branch text copies the workspace path.
 */
export function TaskHeader({
  node,
  project,
  config,
  onSettle,
  onRename,
  onRemove,
  onViewSource,
}: TaskHeaderProps) {
  const { task, sessions } = node;
  const status = taskStatus(sessions.map((entry) => entry.session))?.status;
  const primary = sessions.find(({ session }) => session.kind !== "shell")?.session;
  const agent = primary
    ? [primary.kind, compactLaunchLabel(primary)].filter(Boolean).join(" · ")
    : undefined;
  const where = [project?.name, task.ownsWorktree ? task.branch : undefined]
    .filter(Boolean)
    .join(" › ");
  const {
    observe: observeTitle,
    clipped: titleClipped,
    display: titleDisplay,
  } = useTruncatedText(task.title);
  const { clipped: whereClipped, display: whereDisplay } = useTruncatedText(where, "middle");
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const hint = (label: string, action: ActionId) =>
    config ? `${label} · ${formatBinding(config, action)}` : label;

  const copyPath = () => {
    void navigator.clipboard?.writeText(task.workspacePath).catch(() => {
      // A refused clipboard write leaves the path where it was: selectable in Settings and the
      // menu's own copy; there is no toast to show for a failed copy here.
    });
  };

  return (
    <header
      className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3"
      role="group"
      aria-label="task header"
      // Clicking the header must not take the keyboard from the terminal (`ux.md`).
      onMouseDown={(event) => event.preventDefault()}
    >
      <h1
        ref={observeTitle}
        className="m-0 min-w-0 shrink truncate text-sm font-medium"
        title={titleClipped ? task.title : undefined}
      >
        {titleDisplay}
      </h1>
      <Button
        variant="ghost"
        size="xs"
        aria-label={`${where}: copy workspace path`}
        title={whereClipped ? where : `Copy ${task.workspacePath}`}
        onClick={copyPath}
      >
        <span className="min-w-0 truncate text-xs text-muted-foreground">{whereDisplay}</span>
      </Button>
      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <StatusIndicator status={status} size="chrome" />
          <span className="truncate">{status ? describeStatus(status) : "no status"}</span>
        </span>
        {agent && (
          <Badge variant="secondary" layout="truncate" title={agent}>
            <span className="truncate">{agent}</span>
          </Badge>
        )}
        <IconButton
          label={task.state === "active" ? "Settle task" : "Unsettle task"}
          tooltip={hint(task.state === "active" ? "Settle task" : "Unsettle task", "settle-task")}
          icon={task.state === "active" ? "settle" : "unsettle"}
          onClick={() => onSettle(task)}
        />
        <OverflowMenu label={`Task menu for ${task.title}`} triggerRef={menuTrigger}>
          {onViewSource && task.source !== undefined && (
            <DropdownMenuItem
              onClick={(event) => onViewSource(task, menuTrigger.current ?? event.currentTarget)}
            >
              View issue source…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={(event) => onRename(task, menuTrigger.current ?? event.currentTarget)}
          >
            Rename task…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={copyPath}>Copy workspace path</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => onRemove(task)}>
            Remove task…
          </DropdownMenuItem>
        </OverflowMenu>
      </div>
    </header>
  );
}
