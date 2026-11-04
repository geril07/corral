import type { TaskNode } from "@corral/client/workspace-tree";
import type { ActionId, ClientConfig } from "@corral/protocol/config";
import type { Project, PullRequest, Task, TaskChanges } from "@corral/protocol/rpc";
import { useRef } from "react";
import {
  DropdownMenuItem,
  IconButton,
  OverflowMenu,
  useTruncatedText,
} from "../../common/ui/index.ts";
import { changeCounts, PullRequestBadge } from "../changes/index.ts";
import { formatBinding } from "../keymap/index.ts";

export interface TaskHeaderProps {
  node?: TaskNode | undefined;
  project: Project | undefined;
  changes?: TaskChanges | undefined;
  pullRequest?: PullRequest | undefined;
  config?: ClientConfig | undefined;
  onShowSidebar?: (() => void) | undefined;
  onSettle: (task: Task) => void;
  onRename: (task: Task, opener?: HTMLElement) => void;
  onRemove: (task: Task) => void;
  onViewSource?: ((task: Task, opener?: HTMLElement) => void) | undefined;
}

/** Repository/task context is separate from session navigation; copying a path is explicit. */
export function TaskHeader({
  node,
  project,
  changes,
  pullRequest,
  config,
  onShowSidebar,
  onSettle,
  onRename,
  onRemove,
  onViewSource,
}: TaskHeaderProps) {
  const task = node?.task;
  const taskTitle = task?.title ?? "New task";
  const where = [project?.name, task?.ownsWorktree ? task.branch : undefined]
    .filter(Boolean)
    .join(" › ");
  const {
    observe: observeTitle,
    clipped: titleClipped,
    display: titleDisplay,
  } = useTruncatedText(taskTitle);
  const {
    observe: observeRepository,
    clipped: repositoryClipped,
    display: repositoryDisplay,
  } = useTruncatedText(where, "middle");
  const trigger = useRef<HTMLButtonElement>(null);
  const hint = (label: string, action: ActionId) =>
    config ? `${label} · ${formatBinding(config, action)}` : label;
  const copyPath = () => {
    if (!task) return;
    void navigator.clipboard?.writeText(task.workspacePath).catch(() => {
      /* The host can refuse clipboard access. */
    });
  };
  return (
    <header
      className="flex h-11 shrink-0 items-center gap-2 px-3"
      role="group"
      aria-label="task header"
      onMouseDown={(event) => event.preventDefault()}
    >
      {onShowSidebar && (
        <IconButton label="Show sidebar" icon="show-sidebar" onClick={onShowSidebar} />
      )}
      <span
        ref={observeRepository}
        data-task-repository=""
        aria-label={where}
        className="max-w-48 min-w-0 shrink truncate text-xs text-muted-foreground"
        title={repositoryClipped ? where : undefined}
      >
        {repositoryDisplay}
      </span>
      <span aria-hidden className="text-muted-foreground">
        /
      </span>
      <h1
        ref={observeTitle}
        className="m-0 min-w-0 flex-1 truncate text-sm font-medium"
        title={titleClipped ? taskTitle : undefined}
      >
        {titleDisplay}
      </h1>
      {task && (
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {changeCounts(changes) !== undefined && (
            <span
              className="font-mono text-xs tabular-nums text-muted-foreground"
              title={
                changeCounts(changes)?.endsWith("(partial)")
                  ? "A lower bound: the file list was capped or a file was counted from a prefix"
                  : undefined
              }
            >
              {changeCounts(changes)}
            </span>
          )}
          {pullRequest !== undefined && <PullRequestBadge request={pullRequest} />}
          <OverflowMenu label={`Task menu for ${task.title}`} triggerRef={trigger}>
            <DropdownMenuItem
              title={hint("Settle or unsettle task", "settle-task")}
              onClick={() => onSettle(task)}
            >
              {task.state === "active" ? "Settle task" : "Unsettle task"}
            </DropdownMenuItem>
            {onViewSource && task.source !== undefined && (
              <DropdownMenuItem
                onClick={(event) => onViewSource(task, trigger.current ?? event.currentTarget)}
              >
                View issue source…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={(event) => onRename(task, trigger.current ?? event.currentTarget)}
            >
              Rename task…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={copyPath}>Copy workspace path</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => onRemove(task)}>
              Remove task…
            </DropdownMenuItem>
          </OverflowMenu>
        </div>
      )}
    </header>
  );
}
