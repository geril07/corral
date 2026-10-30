import { describeStatus, formatAge } from "@corral/client/agent-status";
import type { BoardRow as Row } from "@corral/client/board";
import { stepActive } from "@corral/client/terminal-selection";
import { useEffect, useRef, useState } from "react";
import { BoardList, BoardRow } from "../../common/ui/index.ts";
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
    <section className="flex h-full min-h-0 flex-col p-4" aria-label="Board">
      <h1 className="mb-2 text-lg">Board</h1>
      {rows.length === 0 ? (
        <p className="text-text-muted">No active tasks.</p>
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
                <span className="truncate">
                  <span className="text-text-muted">{row.project.name}</span> {row.task.title}
                </span>
                <span className="truncate text-text-muted" title={status?.message}>
                  {status?.message}
                </span>
                <span className="truncate text-right text-text-muted">
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
