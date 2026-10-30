import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

/** Schema changes, oldest first. `PRAGMA user_version` counts the ones applied; never edit one that shipped. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     path TEXT NOT NULL UNIQUE,
     default_base_branch TEXT NOT NULL
   ) STRICT;
   CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     branch TEXT NOT NULL,
     workspace_path TEXT NOT NULL,
     owns_worktree INTEGER NOT NULL,
     state TEXT NOT NULL,
     created_at INTEGER NOT NULL
   ) STRICT;
   CREATE INDEX tasks_by_project ON tasks(project_id);`,
];

export const DATABASE_FILE = "corral.db";

/** Opens `<dataDir>/corral.db`, creating the directory and bringing the schema up to date. */
export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, DATABASE_FILE));
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    migrate(db, MIGRATIONS);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function migrate(db: DatabaseSync, migrations: readonly string[]): void {
  const applied = schemaVersion(db);
  if (applied > migrations.length)
    throw new Error(
      `database schema version ${applied} is newer than this server knows (${migrations.length})`,
    );
  for (let version = applied; version < migrations.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(migrations[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  return Number(row?.["user_version"] ?? 0);
}
