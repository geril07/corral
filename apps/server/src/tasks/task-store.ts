import { Task, TaskSource } from "@corral/protocol/rpc";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const Row = Task.extend({
  ownsWorktree: z.number().transform((value) => value === 1),
  source: z.string().nullable().transform(parseSource),
});

const COLUMNS = `id, project_id AS projectId, title, title_source AS titleSource, source, prompt,
  primary_session_id AS primarySessionId, branch, workspace_path AS workspacePath,
  owns_worktree AS ownsWorktree, state, seen_at AS seenAt, created_at AS createdAt`;

export class TaskStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  list(): Task[] {
    return this.#db
      .prepare(`SELECT ${COLUMNS} FROM tasks ORDER BY rowid`)
      .all()
      .map((row) => Row.parse(row));
  }

  get(id: string): Task | undefined {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`).get(id);
    return row && Row.parse(row);
  }

  idsOfProject(projectId: string): string[] {
    return this.#db
      .prepare("SELECT id FROM tasks WHERE project_id = ?")
      .all(projectId)
      .map((row) => z.string().parse(row["id"]));
  }

  /** Stores every field of the task, `primarySessionId` included; nothing is silently dropped. */
  insert(task: Task): void {
    this.#db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, title_source, source, prompt, primary_session_id, branch, workspace_path, owns_worktree, state, seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.projectId,
        task.title,
        task.titleSource,
        task.source === undefined ? null : JSON.stringify(task.source),
        task.prompt,
        task.primarySessionId,
        task.branch,
        task.workspacePath,
        task.ownsWorktree ? 1 : 0,
        task.state,
        task.seenAt,
        task.createdAt,
      );
  }

  /**
   * Records the primary session on a task that is already stored. Task creation needs this: the
   * task row exists before its session, because the session's foreign key needs it, and the id is
   * only known once the session has started.
   */
  setPrimarySession(id: string, sessionId: string): void {
    this.#db.prepare("UPDATE tasks SET primary_session_id = ? WHERE id = ?").run(sessionId, id);
  }

  setState(id: string, state: Task["state"]): void {
    this.#db.prepare("UPDATE tasks SET state = ? WHERE id = ?").run(state, id);
  }

  /** Stores a title the user chose, which is now where the title came from. */
  rename(id: string, title: string): void {
    this.#db
      .prepare("UPDATE tasks SET title = ?, title_source = 'user' WHERE id = ?")
      .run(title, id);
  }

  setSeenAt(id: string, seenAt: number): void {
    this.#db.prepare("UPDATE tasks SET seen_at = ? WHERE id = ?").run(seenAt, id);
  }

  delete(id: string): void {
    this.#db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }
}

function parseSource(value: string | null): TaskSource | undefined {
  return value === null ? undefined : TaskSource.parse(JSON.parse(value));
}
