import { Project } from "@corral/protocol/rpc";
import type { DatabaseSync } from "node:sqlite";

const COLUMNS = "id, name, path, default_base_branch AS defaultBaseBranch";

export class ProjectStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  list(): Project[] {
    return this.#db.prepare(`SELECT ${COLUMNS} FROM projects ORDER BY rowid`).all().map(toProject);
  }

  get(id: string): Project | undefined {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM projects WHERE id = ?`).get(id);
    return row && toProject(row);
  }

  findByPath(path: string): Project | undefined {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM projects WHERE path = ?`).get(path);
    return row && toProject(row);
  }

  insert(project: Project): void {
    this.#db
      .prepare("INSERT INTO projects (id, name, path, default_base_branch) VALUES (?, ?, ?, ?)")
      .run(project.id, project.name, project.path, project.defaultBaseBranch);
  }

  /** Tasks of the project go with it (foreign key cascade). */
  delete(id: string): void {
    this.#db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }
}

function toProject(row: unknown): Project {
  return Project.parse(row);
}
