import { describeStatus, formatAge } from "@corral/client/agent-status";
import type { BoardRow as Row } from "@corral/client/board";
import { stepActive } from "@corral/client/terminal-selection";
import { useEffect, useRef, useState } from "react";
import {
  BoardList,
  BoardRow,
  Button,
  Icon,
  Hint,
  useTruncatedText,
} from "../../common/ui/index.ts";
import { useNow } from "../../common/hooks/use-now.ts";
import { StatusIndicator } from "../status/index.ts";

interface BoardProps {
  rows: readonly Row[];
  /** Enter or a click on a row: show that task, at the session that needs attention. */
  onJump: (row: Row) => void;
  onClose: () => void;
}

const AGE_REFRESH_MS = 30_000;

/** Every active task with its status, most urgent first. Arrows or j/k move, Enter jumps. */
export function Board({ rows, onJump, onClose }: BoardProps) {
  // Follows the task, not the position, so a status change that reorders rows moves nothing under the cursor.
  const [highlightedTask, setHighlightedTask] = useState<string>();
  const listRef = useRef<HTMLUListElement>(null);
  const now = useNow(AGE_REFRESH_MS);
  const highlighted = rows.find((row) => row.task.id === highlightedTask) ?? rows[0];

  useEffect(() => {
    listRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [onClose]);

  const step = (direction: 1 | -1) =>
    setHighlightedTask(
      stepActive(
        rows.map((row) => row.task.id),
        highlighted?.task.id,
        direction,
      ),
    );

  return (
    <section className="flex h-full min-h-0 flex-col p-3" aria-label="Board">
      <div className="mb-2 flex h-8 items-center gap-2 border-b border-border pb-1.5">
        <Button variant="ghost" size="sm" aria-label="Back to workspace" onClick={onClose}>
          <Icon name="back" />
          Back
        </Button>
        <h1 className="m-0 text-base font-semibold">Board</h1>
        <span className="ml-auto text-xs text-muted-foreground">
          {rows.length} active {rows.length === 1 ? "task" : "tasks"}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground">No active tasks.</p>
      ) : (
        <BoardList
          ref={listRef}
          role="listbox"
          aria-label="tasks"
          tabIndex={0}
          aria-activedescendant={highlighted && `board-${highlighted.task.id}`}
          onKeyDown={(event) => {
            if (event.ctrlKey || event.altKey || event.metaKey) return;
            if (event.key === "Enter" && highlighted) onJump(highlighted);
            else if (event.key === "ArrowDown" || event.code === "KeyJ") step(1);
            else if (event.key === "ArrowUp" || event.code === "KeyK") step(-1);
            else return;
            event.preventDefault();
          }}
        >
          {rows.map((row) => {
            const { status } = row;
            return (
              <BoardRow
                key={row.task.id}
                id={`board-${row.task.id}`}
                role="option"
                aria-selected={row === highlighted}
                ref={(element) => {
                  if (row === highlighted) element?.scrollIntoView({ block: "nearest" });
                }}
                onClick={() => onJump(row)}
              >
                <StatusIndicator status={status} />
                <span className="truncate">{status ? describeStatus(status) : "no status"}</span>
                <BoardTask project={row.project.name} title={row.task.title} />
                <BoardMessage message={status?.message} />
                <span className="truncate text-right text-muted-foreground">
                  {status ? formatAge(now, status.updatedAt) : ""}
                </span>
              </BoardRow>
            );
          })}
        </BoardList>
      )}
    </section>
  );
}

function BoardMessage({ message }: { message: string | undefined }) {
  const { observe, clipped } = useTruncatedText(message ?? "");
  const content = (
    <span
      ref={observe}
      className="block truncate text-muted-foreground"
      title={clipped ? message : undefined}
    >
      {message}
    </span>
  );
  return clipped && message ? <Hint content={message}>{content}</Hint> : content;
}

function BoardTask({ project, title }: { project: string; title: string }) {
  const full = `${project} ${title}`;
  const { observe, clipped } = useTruncatedText(full);
  const content = (
    <span ref={observe} className="block truncate" title={clipped ? full : undefined}>
      <span className="text-muted-foreground">{project}</span> {title}
    </span>
  );
  return clipped ? <Hint content={full}>{content}</Hint> : content;
}
