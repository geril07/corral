import { Task } from "@corral/protocol/rpc";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const Row = Task.extend({ ownsWorktree: z.number().transform((value) => value === 1) });

const COLUMNS = `id, project_id AS projectId, title, branch, workspace_path AS workspacePath,
  owns_worktree AS ownsWorktree, state, created_at AS createdAt`;

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

  insert(task: Task): void {
    this.#db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, branch, workspace_path, owns_worktree, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.projectId,
        task.title,
        task.branch,
        task.workspacePath,
        task.ownsWorktree ? 1 : 0,
        task.state,
        task.createdAt,
      );
  }

  setState(id: string, state: Task["state"]): void {
    this.#db.prepare("UPDATE tasks SET state = ? WHERE id = ?").run(state, id);
  }

  delete(id: string): void {
    this.#db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }
}
