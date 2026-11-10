import { attentionWord, isSeenDone, isUnseenDone, taskStatus } from "@corral/client/agent-status";
import type { TaskNode } from "@corral/client/workspace-tree";
import type { ActionId, ClientConfig } from "@corral/protocol/config";
import type { Project, PullRequest, Task, TaskChanges } from "@corral/protocol/rpc";
import { useRef, useState } from "react";
import {
  DropdownMenuItem,
  IconButton,
  OverflowMenu,
  useTruncatedText,
} from "../../common/ui/index.ts";
import { changeCounts, PullRequestBadge } from "../changes/index.ts";
import { formatBinding } from "../keymap/index.ts";
import { StatusIndicator } from "../status/index.ts";
import { branchName, recordedBranchAccessible, recordedBranchLabel } from "../tasks/index.ts";

interface CopyNotice {
  readonly outcome: "copied" | "refused";
  readonly message: string;
}

/** The host's own refusal sentence, or ours when the clipboard is absent. */
function clipboardRefusal(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "Clipboard access is unavailable.";
}

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

/** Repository/branch context is separate from session navigation; copying a path is explicit. */
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
  const status =
    node === undefined
      ? undefined
      : taskStatus(node.sessions.map((entry) => entry.session))?.status;
  const unseen = task !== undefined && isUnseenDone(task, status);
  const attention = attentionWord(status);
  const taskTitle = task?.title ?? "New task";
  const branchText =
    task?.branch == null ? undefined : recordedBranchLabel(task.branch, "detached");
  const branchAccessible = task?.branch == null ? undefined : recordedBranchAccessible(task.branch);
  const where = [project?.name, branchText].filter(Boolean).join(" / ");
  const whereName = [project?.name, branchAccessible].filter(Boolean).join(" / ");
  const copyableBranch = task === undefined ? undefined : branchName(task.branch);
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
  const [copyNotice, setCopyNotice] = useState<CopyNotice | undefined>(undefined);
  const clearCopyNotice = () => setCopyNotice(undefined);
  const hint = (label: string, action: ActionId) =>
    config ? `${label} · ${formatBinding(config, action)}` : label;
  const copy = async (text: string, copied: string) => {
    clearCopyNotice();
    try {
      const clipboard = navigator.clipboard;
      if (clipboard === undefined) throw new Error("Clipboard access is unavailable.");
      await clipboard.writeText(text);
      setCopyNotice({ outcome: "copied", message: copied });
    } catch (error) {
      setCopyNotice({ outcome: "refused", message: clipboardRefusal(error) });
    }
  };
  return (
    <header
      className="flex h-(--chrome-header) shrink-0 items-center gap-2 px-3"
      role="group"
      aria-label="task header"
      onMouseDown={(event) => {
        clearCopyNotice();
        // Text keeps the browser's selection default; every other part of the row keeps focus
        // where it was, as the row controls themselves do below.
        if (event.target instanceof Element && event.target.closest("[data-header-text]")) return;
        event.preventDefault();
      }}
    >
      {onShowSidebar && (
        <IconButton
          label="Show sidebar"
          icon="show-sidebar"
          onClick={() => {
            clearCopyNotice();
            onShowSidebar();
          }}
          onMouseDown={(event) => event.preventDefault()}
        />
      )}
      <span
        ref={observeRepository}
        data-task-repository=""
        data-header-text=""
        aria-label={whereName}
        className="max-w-48 min-w-0 shrink truncate text-xs text-muted-foreground"
        title={repositoryClipped ? whereName : undefined}
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
        <span data-header-text="">{titleDisplay}</span>
      </h1>
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        title={copyNotice?.message}
        className={
          copyNotice === undefined
            ? "sr-only"
            : copyNotice.outcome === "refused"
              ? "max-w-56 min-w-0 shrink truncate text-xs text-destructive"
              : "max-w-56 min-w-0 shrink truncate text-xs text-muted-foreground"
        }
      >
        {copyNotice?.message}
      </p>
      {task && (
        <div
          className="ml-auto flex shrink-0 items-center gap-1.5"
          data-task-header-actions=""
          onMouseDown={(event) => event.preventDefault()}
        >
          {task.state === "settled" && (
            <span data-task-state="settled" className="shrink-0 text-xs text-muted-foreground">
              Settled
            </span>
          )}
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
          {status !== undefined && (
            <span className="flex shrink-0 items-center gap-1.5" data-task-status="">
              <StatusIndicator status={status} size="chrome" muted={isSeenDone(status, unseen)} />
              {attention !== undefined && (
                <span className="whitespace-nowrap text-xs text-muted-foreground">{attention}</span>
              )}
            </span>
          )}
          <OverflowMenu
            label={`Task menu for ${task.title}`}
            triggerRef={trigger}
            onOpenChange={(open) => {
              if (open) clearCopyNotice();
            }}
          >
            <DropdownMenuItem
              title={hint("Settle or unsettle task", "settle-task")}
              onClick={() => {
                clearCopyNotice();
                onSettle(task);
              }}
            >
              {task.state === "active" ? "Settle task" : "Unsettle task"}
            </DropdownMenuItem>
            {onViewSource && task.source !== undefined && (
              <DropdownMenuItem
                onClick={(event) => {
                  clearCopyNotice();
                  onViewSource(task, trigger.current ?? event.currentTarget);
                }}
              >
                View issue source…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={(event) => {
                clearCopyNotice();
                onRename(task, trigger.current ?? event.currentTarget);
              }}
            >
              Rename task…
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void copy(task.workspacePath, "Workspace path copied")}
            >
              Copy workspace path
            </DropdownMenuItem>
            {copyableBranch !== undefined && (
              <DropdownMenuItem onClick={() => void copy(copyableBranch, "Branch copied")}>
                Copy branch
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              variant="destructive"
              onClick={() => {
                clearCopyNotice();
                onRemove(task);
              }}
            >
              Remove task…
            </DropdownMenuItem>
          </OverflowMenu>
        </div>
      )}
    </header>
  );
}
