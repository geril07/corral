import { describeStatus, formatAge } from "@corral/client/agent-status";
import type { BoardRow } from "@corral/client/board";
import { stepActive } from "@corral/client/terminal-selection";
import { useState } from "react";
import { Modal } from "./Modal.tsx";
import { StatusIndicator } from "./StatusIndicator.tsx";
import { useNow } from "./use-now.ts";

interface BoardProps {
  rows: readonly BoardRow[];
  /** Enter or a click on a row: show that task, at the session that needs attention. */
  onJump: (row: BoardRow) => void;
  onClose: () => void;
}

const AGE_REFRESH_MS = 30_000;

/** Every active task with its status, most urgent first. Arrows or j/k move, Enter jumps. */
export function Board({ rows, onJump, onClose }: BoardProps) {
  // Follows the task, not the position, so a status change that reorders rows moves nothing under the cursor.
  const [highlightedTask, setHighlightedTask] = useState<string>();
  const now = useNow(AGE_REFRESH_MS);
  const highlighted = rows.find((row) => row.task.id === highlightedTask) ?? rows[0];

  const step = (direction: 1 | -1) =>
    setHighlightedTask(
      stepActive(
        rows.map((row) => row.task.id),
        highlighted?.task.id,
        direction,
      ),
    );

  return (
    <Modal title="Board" className="board" onClose={onClose}>
      {rows.length === 0 ? (
        <p className="hint">No active tasks.</p>
      ) : (
        <ul
          className="board-rows"
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
              <li
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
                <span className="board-status">
                  {status ? describeStatus(status) : "no status"}
                </span>
                <span className="board-task">
                  <span className="board-project">{row.project.name}</span> {row.task.title}
                </span>
                <span className="board-message" title={status?.message}>
                  {status?.message}
                </span>
                <span className="board-age">{status ? formatAge(now, status.updatedAt) : ""}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
